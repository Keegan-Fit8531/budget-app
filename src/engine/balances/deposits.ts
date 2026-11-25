import { addDays, todayISO, type ISODate } from '../../core/dates';
import { debtPay, projectedOwed } from '../../features/debts/logic/amounts';
import { heldDebtPaymentsIn, isHoldDisplayAccount } from '../../features/debts/logic/funding';
import { envelopeOn, setAsideOn } from '../setAside';
import { periodContaining, type Period } from '../periods';
import type { Budget, Cents } from '../../core/types';
import { paySplitLocked } from './freeze';
import { topsUp, exactTopUp, sentBeforeBudget } from './topUps';
import { modeOf, exactNeed } from './outflows';
import { usualSteady, steadyFor } from './steady';

/**
 * What payday sends to an account in a period, by its mode. The Planner and every balance projection
 * use this, so they always agree. `usual`: ignore a one-pay adjustment (what it would normally send).
 */
export function depositFor(b: Budget, accountId: string, p: Period, today: ISODate = todayISO(), opts: { usual?: boolean } = {}): Cents {
  if (!opts.usual) {
    const frozen = b.splitSent?.[p.start]?.[accountId];
    const override = b.overrides?.[p.start]?.[accountId];
    // Locked freeze is the cycle’s record; a hand edit (override ≠ freeze) still wins.
    if (frozen !== undefined && paySplitLocked(b, p, today)) {
      if (override !== undefined && !isHoldDisplayAccount(b, accountId) && override !== frozen) return override;
      return frozen;
    }
    // A one-pay adjustment (e.g. from Balance this pay) replaces the usual amount for that pay.
    if (override !== undefined && !isHoldDisplayAccount(b, accountId)) return override;
  }
  return liveDepositFor(b, accountId, p, today, opts);
}

/** Live (unfrozen) deposit amount — used to build the freeze snapshot and for unlocked pays. */
export function liveDepositFor(b: Budget, accountId: string, p: Period, today: ISODate, opts: { usual?: boolean } = {}): Cents {
  // Debt card whose money is held elsewhere (e.g. Gem → Misc bills): always show this pay's send amount
  // on the debt card. The money is in the hold account's send (a one-pay amount on the debt card, like
  // Optimise's extra, goes out from there too: `debtPaymentsIn`), so the totals leave this card out.
  if (isHoldDisplayAccount(b, accountId)) {
    return heldDebtPaymentsIn(b, accountId, p.start, p.end, opts).reduce((t, x) => t + x.amount, 0);
  }
  // A pay before the budget started (already split): what it actually sent.
  const sentEarlier = sentBeforeBudget(b, accountId, p);
  if (sentEarlier !== undefined) return sentEarlier;
  // A savings account whose goals have all passed their target date (e.g. after the wedding) gets nothing more.
  const goals = (b.savings ?? []).filter((g) => g.accountId === accountId);
  if (goals.length && goals.every((g) => g.targetDate && g.targetDate <= p.start)) return 0;
  const line = b.split.find((l) => l.accountId === accountId);
  const mode = modeOf(line);
  if (mode === 'exact') return topsUp(b, accountId) ? exactTopUp(b, accountId, p, today) : exactNeed(b, accountId, p);
  if (mode === 'smooth') return steadyFor(b, accountId, p, today);
  const amount = line?.amount ?? 0;
  // A debt never gets more than it still owes (e.g. once a card is paid off, stop sending money).
  const debt = (b.debts ?? []).find((d) => d.accountId === accountId);
  if (debt && (debt.balance || debt.plans.length)) {
    // What it owed going into this pay: for a pay already under way, that's what it owes now plus the
    // payments that have gone out since (so its last payment doesn't turn into $0 once it's made).
    const since = (debt.paid ?? []).reduce((t, x) => t + (x.date >= p.start ? x.amount : 0), 0);
    return Math.min(amount, Math.max(0, projectedOwed(debt, b.settings, addDays(p.start, -1), debtPay(b, debt)) + since));
  }
  // A cost put aside or held in a month envelope is always sent, even with a fixed amount below it.
  return Math.max(amount, setAsideOn(b, accountId, p.start) + envelopeOn(b, accountId, p.start));
}

/**
 * What payday is meant to send, without reading balance-based steady/exact runs. Used to tell whether
 * a payday-morning balance already includes the deposit (calling depositFor here would recurse through
 * runStart).
 */
export function depositSansBalance(b: Budget, accountId: string, p: Period): Cents {
  if (isHoldDisplayAccount(b, accountId)) {
    return heldDebtPaymentsIn(b, accountId, p.start, p.end).reduce((t, x) => t + x.amount, 0);
  }
  const override = b.overrides?.[p.start]?.[accountId];
  if (override !== undefined) return override;
  const start = b.settings.budgetStart;
  if (start && p.start < start) {
    const line = b.split.find((l) => l.accountId === accountId);
    const acc = b.accounts.find((a) => a.id === accountId);
    return acc?.kind === 'bank' && line && line.amount > 0 ? line.amount : 0;
  }
  const goals = (b.savings ?? []).filter((g) => g.accountId === accountId);
  if (goals.length && goals.every((g) => g.targetDate && g.targetDate <= p.start)) return 0;
  const line = b.split.find((l) => l.accountId === accountId);
  const mode = modeOf(line);
  if (mode === 'exact') return exactNeed(b, accountId, p);
  if (mode === 'smooth') return usualSteady(b, accountId);
  return Math.max(line?.amount ?? 0, setAsideOn(b, accountId, p.start) + envelopeOn(b, accountId, p.start));
}

/**
 * A balance dated on payday often still excludes that payday's deposit: pay can land late in the
 * day, and the split into this account may not have run. True when the entered balance still looks
 * like the pre-deposit amount.
 */
export function depositPending(b: Budget, accountId: string, entry: { amount: Cents; asOf: ISODate }): boolean {
  const p = periodContaining(entry.asOf, b.settings);
  if (entry.asOf !== p.start) return false;
  const deposit = depositSansBalance(b, accountId, p);
  if (deposit <= 0) return false;
  // Money already paid into the account on payday (the split, or pay landing).
  const credited = (b.accountTransactions?.[accountId] ?? [])
    .filter((t) => t.date === entry.asOf && t.amount > 0)
    .reduce((s, t) => s + t.amount, 0);
  if (credited >= deposit) return false;
  // Last balance before payday: if this one hasn't risen by the deposit, it isn't in yet.
  // (Bank sync on payday morning often only bumps the date, leaving the amount unchanged.)
  const prior = (b.accountHistory?.[accountId] ?? [])
    .filter((e) => e.kind === 'balance' && e.date < entry.asOf)
    .reduce<{ amount: Cents; date: ISODate } | undefined>((best, e) => (!best || e.date >= best.date ? e : best), undefined);
  if (prior) return entry.amount - prior.amount + credited < deposit;
  // No earlier reading: a balance below the deposit itself can't include it.
  return entry.amount + credited < deposit;
}

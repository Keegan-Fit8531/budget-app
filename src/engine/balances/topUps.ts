import { addDays, todayISO, type ISODate } from '../../core/dates';
import { accountHasPlans } from '../../features/debts/logic/funding';
import { firstBudgetPay, shiftPeriod, type Period } from '../periods';
import { accountHasGoals, savingsNeedIn } from '../../features/savings/logic/savings';
import type { Budget, Cents } from '../../core/types';
import { accountMode, fundedOut, exactNeed } from './outflows';
import { pausedAside, window, between, runStart, runLength, type Run, cached, runKey, fromRun } from './steady';

// ---------------------------------------------------------------------------------------------
// Exact accounts top up: what's left from earlier pays counts towards the next pay's bills.
// ---------------------------------------------------------------------------------------------

/** Exact accounts that pay bills from a bank account (not debts or savings): leftovers count towards the next pay. */
export function topsUp(b: Budget, accountId: string): boolean {
  const a = b.accounts.find((x) => x.id === accountId);
  // Not for a debt paid from here. A debt only held here until statement day (Gem in Misc bills) is fine
  // once a balance is entered: what's left over then is real, so the next pay sends that much less.
  const held = accountHasPlans(b, accountId) && !(b.debts ?? []).some((d) => d.accountId === accountId) && !!b.balances?.[accountId];
  return !!a && a.kind === 'bank' && accountMode(b, accountId) === 'exact' && !accountHasGoals(b, accountId) && (!accountHasPlans(b, accountId) || held);
}

/** Pay-by-pay run for an exact account that tops up: each pay's bills less what's already there. */
function topUpRun(b: Budget, accountId: string, today: ISODate, useBalance = true, until?: ISODate): Run {
  return cached(b, runKey(b, 'topup', accountId, today, useBalance) + (until ?? ''), () => {
    const s = b.settings;
    const start = runStart(b, accountId, today, useBalance);
    const count = runLength(start.pay, today, s, until);
    const { slots, out } = window(b, accountId, start.pay, count);
    let bal = start.bal - fundedOut(b, accountId, addDays(start.cursor, 1), addDays(start.pay.start, -1)).reduce((t, o) => t + o.amount, 0);
    const amounts = new Map<string, Cents>();
    const idx = { i: 0 };
    for (let i = 0; i < count; i++) {
      const date = slots[i].date;
      // The bills, money put aside (and any savings-goal amount), less what's already there, or plus what an earlier pay left short.
      const spent = between(out, date, slots[i + 1].date, idx).reduce((t, o) => t + o.amount, 0) + savingsNeedIn(b, accountId, date);
      const amt = Math.max(0, spent - bal);
      amounts.set(date, amt);
      const sent = slots[i].fixed ?? amt;
      bal += sent - spent + pausedAside(b, accountId, date, amt, sent);
    }
    return { first: slots[0].date, amounts };
  });
}

/**
 * What an exact account gets each pay: that pay's bills, less whatever is already left in the account
 * just before payday (from your balance, or what earlier pays left over). Never less than $0.
 * Worked out pay by pay, so a pay that's sent less or more than needed carries into the next one.
 */
export function exactTopUp(b: Budget, accountId: string, p: Period, today: ISODate = todayISO()): Cents {
  return fromRun(b, accountId, p, today, topUpRun, () => sentBeforeBudget(b, accountId, p) ?? exactNeed(b, accountId, p));
}

/**
 * With no balance entered: what's left in an account the day before the first budgeted pay, from what the
 * pay before it sent (e.g. the last pay's fixed amount for a bills account, less that pay's bills). 0 if unknown.
 */
export function leftoverBeforeBudget(b: Budget, accountId: string, today: ISODate = todayISO()): Cents {
  return b.balances?.[accountId] ? 0 : priorLeftover(b, accountId, today);
}

/** What the pay before the budget left in an account (whether or not you've entered a balance since). */
export function priorLeftover(b: Budget, accountId: string, today: ISODate): Cents {
  const acc = b.accounts.find((a) => a.id === accountId);
  if (!acc || acc.kind !== 'bank' || accountHasGoals(b, accountId) || accountHasPlans(b, accountId)) return 0;
  const first = firstBudgetPay(b, today);
  const prev = shiftPeriod(first, -1, b.settings);
  // What it sent: a one-pay adjustment made to it (e.g. topped up by transfer), or its fixed amount.
  const sent = b.overrides?.[prev.start]?.[accountId] ?? sentBeforeBudget(b, accountId, prev);
  return sent === undefined ? 0 : sent - fundedOut(b, accountId, prev.start, addDays(first.start, -1)).reduce((t, o) => t + o.amount, 0);
}

/** What a pay before the budget started sent to an account: its last fixed amount. */
export function sentBeforeBudget(b: Budget, accountId: string, p: Period): Cents | undefined {
  const start = b.settings.budgetStart;
  if (!start || p.start >= start) return undefined;
  const line = b.split.find((l) => l.accountId === accountId);
  const acc = b.accounts.find((a) => a.id === accountId);
  return acc?.kind === 'bank' && line && line.amount > 0 ? line.amount : undefined;
}

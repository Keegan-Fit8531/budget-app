import { addDays, todayISO, type ISODate } from '../../core/dates';
import { periodContaining, shiftPeriod, type Period } from '../periods';
import type { Budget, Cents } from '../../core/types';
import { type Outflow, outflows } from './outflows';
import { depositFor, depositSansBalance, depositPending } from './deposits';
import { estimateBalance, balanceToday } from './estimate';

// ---------------------------------------------------------------------------------------------
// Live bill tracking for an account across the current pay period.
// ---------------------------------------------------------------------------------------------

export interface BillRow extends Outflow {
  status: 'paid' | 'today' | 'due';
  /** Days from today (0 = today, negative = days ago). */
  days: number;
  /** For bills still to come: whether the money in the account covers it (in date order). */
  covered?: boolean;
}

export interface BillTracker {
  period: Period;
  /** Day number within the pay period (1 = payday). */
  day: number;
  rows: BillRow[];
  paid: Cents;
  toCome: Cents;
  /** What payday put in this period. */
  deposit: Cents;
  /** Money in the account now: from your entered balance, or estimated. */
  balance: Cents;
  balanceSource: 'entered' | 'estimated';
  /** False when the balance isn't entered and this pay was split before the budget started — so it can't be estimated. */
  balanceKnown: boolean;
  spare: Cents;
  /** The next payday's deposit and the bills it's for (the following period). */
  next: { period: Period; deposit: Cents; rows: Outflow[] };
}

/**
 * How much has already left the account today (bank sync / stored transactions). Used so a Thursday
 * transfer that already hit the balance isn't still counted as "to come".
 */
function debitedToday(b: Budget, accountId: string, today: ISODate): Cents {
  const seen = [...(b.accountTransactions?.[accountId] ?? []), ...(b.pendingTransactions?.[accountId] ?? [])];
  return seen.filter((t) => t.date === today && t.amount < 0).reduce((s, t) => s - t.amount, 0);
}

/**
 * True when today's entered/synced balance already has today's bills out (e.g. $1,000 in, $200
 * transferred, balance now $800). Without this, those bills stay "to come" and the account looks short.
 */
function todaysBillsAlreadyOut(b: Budget, accountId: string, today: ISODate, todayOut: Cents): boolean {
  if (todayOut <= 0) return false;
  if (debitedToday(b, accountId, today) >= todayOut) return true;
  const entry = b.balances?.[accountId];
  if (!entry || entry.asOf !== today) return false;
  const period = periodContaining(today, b.settings);
  // Payday: balance + today's bills ≈ what payday sent (you deposited, then the Thursday transfer left).
  if (today === period.start) {
    const sent = b.splitSent?.[period.start]?.[accountId]
      ?? b.overrides?.[period.start]?.[accountId]
      ?? depositSansBalance(b, accountId, period);
    if (Math.abs(entry.amount + todayOut - sent) <= 100) return true;
  }
  const prior = estimateBalance(b, accountId, addDays(today, -1), today);
  if (prior === undefined) return false;
  const dep = today === period.start && !depositPending(b, accountId, entry) ? depositSansBalance(b, accountId, period) : 0;
  const beforeBills = prior + dep;
  // Balance matches "deposit in, today's bills out" (within $1), not the pre-bill figure.
  return entry.amount <= beforeBills - todayOut + 100 && entry.amount < beforeBills - 100;
}

export function billTracker(b: Budget, accountId: string, today: ISODate = todayISO()): BillTracker {
  const s = b.settings;
  const period = periodContaining(today, s);
  const rows: BillRow[] = outflows(b, accountId, period.start, period.end).map((o) => {
    const days = Math.round((Date.parse(o.date) - Date.parse(today)) / 86400000);
    return { ...o, days, status: (days < 0 ? 'paid' : days === 0 ? 'today' : 'due') as BillRow['status'] };
  });
  // Bank already shows today's bill(s) out: treat them as paid so $800 after a $200 transfer isn't
  // "short $200" against five weeks still listed as to come.
  const todayOut = rows.filter((r) => r.status === 'today').reduce((t, r) => t + r.amount, 0);
  let cover = todaysBillsAlreadyOut(b, accountId, today, todayOut) ? todayOut : debitedToday(b, accountId, today);
  for (const r of rows) {
    if (r.status !== 'today' || cover < r.amount) continue;
    r.status = 'paid';
    cover -= r.amount;
  }
  const paid = rows.filter((r) => r.status === 'paid').reduce((t, r) => t + r.amount, 0);
  const toCome = rows.filter((r) => r.status !== 'paid').reduce((t, r) => t + r.amount, 0);
  const deposit = depositFor(b, accountId, period, today);
  // Balance before today's bills, from the balance you entered (the same figure as the card's headline).
  const entered = balanceToday(b, accountId, today);
  // Without an entered balance: assume this pay's deposit minus what's been paid so far.
  const balance = entered ?? deposit - paid;
  let left = balance;
  for (const r of rows) if (r.status !== 'paid') { r.covered = left >= r.amount; left -= r.amount; }
  const nextPeriod = shiftPeriod(period, 1, s);
  return {
    period, day: Math.round((Date.parse(today) - Date.parse(period.start)) / 86400000) + 1,
    rows, paid, toCome, deposit, balance, balanceSource: entered === undefined ? 'estimated' : 'entered',
    balanceKnown: entered !== undefined || !s.budgetStart || period.start >= s.budgetStart,
    spare: balance - toCome,
    next: { period: nextPeriod, deposit: depositFor(b, accountId, nextPeriod, today), rows: outflows(b, accountId, nextPeriod.start, nextPeriod.end) },
  };
}

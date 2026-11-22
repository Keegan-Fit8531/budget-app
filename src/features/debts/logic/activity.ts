import { addDays, addMonths, diffDays, type ISODate } from '../../../core/dates';
import { depositFor } from '../../../engine/balances/deposits';
import { paySplitLocked } from '../../../engine/balances/freeze';
import { firstBudgetPay, periodContaining, shiftPeriod } from '../../../engine/periods';
import type { Budget, Cents, Debt, DebtPlan } from '../../../core/types';

// ---------------------------------------------------------------------------------------------
// What a debt card shows of its activity: each plan's progress (paid against its total, months gone
// and left), payments to it (pending until the card shows them, then received), and what payday
// sent for it each pay.
// ---------------------------------------------------------------------------------------------

/** Months from `from` until `to`, a part month counting as one. */
export function monthsUntil(from: ISODate, to: ISODate): number {
  let n = 0;
  while (addMonths(from, n) < to && n < 600) n++;
  return n;
}

export interface PlanProgress { paid: Cents; total: Cents; months?: number; monthsLeft?: number }

/** A plan's progress: what's been paid of what it was, and (for a plan with a length) how many months are left. */
export function planProgress(p: DebtPlan, today: ISODate, end?: ISODate): PlanProgress {
  const paid = Math.max(0, p.original - p.remaining);
  const ends = p.type === 'afterpay' || p.type === 'balance' ? undefined : p.ends ?? end;
  if (!ends) return { paid, total: p.original };
  const months = p.months ?? monthsUntil(p.purchaseDate, ends);
  return { paid, total: p.original, months, monthsLeft: Math.min(months, monthsUntil(today, ends)) };
}

/** A payment seen leaving the bank only counts as on its way for this long; after that it has no status. */
const PENDING_DAYS = 7;

export interface PaymentRow {
  date: ISODate; amount: Cents;
  /** The bank account it left (a payment seen there). */
  from?: string;
  /** The card's own description (a payment the card shows that didn't come from a linked account). */
  description?: string;
  /** Pending: sent, not on the card yet. Received: the card shows it (on `on`). None: an older one on a card that isn't linked. */
  state?: 'pending' | 'received';
  on?: ISODate;
  /** What came off what's owed when the card isn't linked (see `services/bank/cardPayments.ts`). */
  counted?: Cents;
}

/**
 * Payments to a debt, latest first: each one seen leaving your bank, matched to the card's own credit of
 * the same amount within a week (received), else pending while recent on a card linked to the bank; then
 * payments the card shows that didn't come from a linked account (refunds, or paid from elsewhere).
 */
export function paymentRows(debt: Debt, linked: boolean, today: ISODate): PaymentRow[] {
  const posted = (debt.transactions ?? []).filter((t) => t.amount > 0).map((t) => ({ ...t, used: false }));
  const pending = (debt.pending ?? []).filter((t) => t.amount > 0).map((t) => ({ ...t, used: false }));
  const take = (list: typeof posted, date: ISODate, amount: Cents) => {
    const hit = list.find((t) => !t.used && t.amount === amount && t.date >= addDays(date, -1) && t.date <= addDays(date, PENDING_DAYS));
    if (hit) hit.used = true;
    return hit;
  };
  const rows: PaymentRow[] = [];
  for (const p of [...(debt.bankPayments ?? [])].sort((a, b) => a.date.localeCompare(b.date))) {
    const got = take(posted, p.date, p.amount);
    const base = { date: p.date, amount: p.amount, from: p.from, counted: p.counted };
    if (got) rows.push({ ...base, state: 'received', on: got.date });
    else if (take(pending, p.date, p.amount) || (linked && diffDays(p.date, today) <= PENDING_DAYS)) rows.push({ ...base, state: 'pending' });
    else rows.push(base);
  }
  for (const t of posted) if (!t.used) rows.push({ date: t.date, amount: t.amount, description: t.description, state: 'received', on: t.date });
  for (const t of pending) if (!t.used) rows.push({ date: t.date, amount: t.amount, description: t.description, state: 'pending' });
  return rows.sort((a, b) => b.date.localeCompare(a.date));
}

export interface PaydayRow { start: ISODate; amount: Cents }

/** What payday sent for a debt, latest pay first: pays already sent, back to the budget's first. */
export function paydayHistory(b: Budget, debt: Debt, today: ISODate, count = 6): PaydayRow[] {
  const first = firstBudgetPay(b, today).start;
  const out: PaydayRow[] = [];
  for (let p = periodContaining(today, b.settings); p.start >= first && out.length < count; p = shiftPeriod(p, -1, b.settings)) {
    if (!paySplitLocked(b, p, today)) continue;
    out.push({ start: p.start, amount: depositFor(b, debt.accountId, p, today) });
  }
  return out;
}

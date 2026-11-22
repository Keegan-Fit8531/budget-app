import { addDays, todayISO, type ISODate } from '../../core/dates';
import { firstBudgetPay, periodContaining, shiftPeriod, type Period } from '../periods';
import type { Budget, Cents } from '../../core/types';
import { depositFor, depositPending } from './deposits';
import { outflows } from './outflows';
import { leftoverBeforeBudget } from './topUps';

/** Estimated balance at the end of `date`, from the last balance you entered. Undefined if unknown. */
export function estimateBalance(b: Budget, accountId: string, date: ISODate, today: ISODate = todayISO()): Cents | undefined {
  const entry = b.balances?.[accountId];
  if (!entry || date < entry.asOf) return undefined;
  let bal = entry.amount;
  let p = periodContaining(entry.asOf, b.settings);
  // Balance as-of payday: count this payday's deposit when the bank still shows the pre-deposit amount.
  if (entry.asOf === p.start && p.start <= date && depositPending(b, accountId, entry)) {
    bal += depositFor(b, accountId, p, today);
  }
  // Paydays after the balance date, up to and including `date`.
  while (p.nextPayday <= date) {
    p = shiftPeriod(p, 1, b.settings);
    bal += depositFor(b, accountId, p, today);
  }
  return bal - outflows(b, accountId, addDays(entry.asOf, 1), date).reduce((t, o) => t + o.amount, 0);
}

/**
 * What's in an account today, before today's payments come out (a bill dated today may not have left
 * the bank yet, so it counts as still to come). A balance entered today is used as-is; an older one is
 * rolled forward to yesterday, plus today's deposit when today is payday (it lands before the bills).
 * Undefined without an entered balance. The Accounts card's headline and the tracker's "In the account"
 * both show this, so they always agree; `estimateBalance` (end of day) is for projections.
 */
export function balanceToday(b: Budget, accountId: string, today: ISODate = todayISO()): Cents | undefined {
  const entry = b.balances?.[accountId];
  if (!entry || entry.asOf > today) return undefined;
  if (entry.asOf === today) return entry.amount;
  const rolled = estimateBalance(b, accountId, addDays(today, -1), today);
  if (rolled === undefined) return undefined;
  const period = periodContaining(today, b.settings);
  return rolled + (today === period.start ? depositFor(b, accountId, period, today) : 0);
}

export interface PeriodForecast { period: Period; deposit: Cents; out: Cents; end: Cents | undefined }

/** Balance forecast for `count` pay periods starting with the one containing `today`. */
export function forecastBalances(b: Budget, accountId: string, count: number, today: ISODate = todayISO()): PeriodForecast[] {
  const entry = b.balances?.[accountId];
  const pending = !!entry && depositPending(b, accountId, entry);
  const rows: PeriodForecast[] = [];
  let p = periodContaining(today, b.settings);
  for (let i = 0; i < count; i++) {
    // Deposit still counts when the balance is as-of this payday but the money hasn't landed yet.
    const received = !entry || p.start > entry.asOf || (p.start === entry.asOf && pending);
    rows.push({
      period: p,
      deposit: received ? depositFor(b, accountId, p, today) : 0,
      out: outflows(b, accountId, entry && entry.asOf > p.start ? addDays(entry.asOf, 1) : p.start, p.end).reduce((t, o) => t + o.amount, 0),
      end: estimateBalance(b, accountId, p.end, today),
    });
    p = shiftPeriod(p, 1, b.settings);
  }
  return rows;
}

/**
 * Projected balance at the end of `date`. From your entered balance when there is one; otherwise from
 * the budget's first pay, starting with what the pay before it left, adding each payday
 * and taking each payment. Undefined when it can't be told (before the budget, or before your balance).
 */
export function balanceOn(b: Budget, accountId: string, date: ISODate, today: ISODate = todayISO()): Cents | undefined {
  const entry = b.balances?.[accountId];
  if (entry) return entry.asOf <= date ? estimateBalance(b, accountId, date, today) : undefined;
  const s = b.settings;
  const first = firstBudgetPay(b, today);
  if (date < addDays(first.start, -1)) return undefined;
  let bal = leftoverBeforeBudget(b, accountId, today);
  if (date < first.start) return bal;
  for (let q = first; q.start <= date; q = shiftPeriod(q, 1, s)) bal += depositFor(b, accountId, q, today);
  return bal - outflows(b, accountId, first.start, date).reduce((t, o) => t + o.amount, 0);
}

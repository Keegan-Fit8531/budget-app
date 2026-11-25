import { addDays, todayISO, type ISODate } from '../../core/dates';
import type { Budget, Cents } from '../../core/types';
import { averageNeed } from '../plan';
import type { Period } from '../periods';
import { fundedOut } from './outflows';
import { between, cached, fromRun, runKey, runLength, runStart, window, type Run } from './steady';

// ---------------------------------------------------------------------------------------------
// "Build up" (`SplitLine.mode` 'build'): each payday looks only as far as the next pay that needs more
// than the account's average (a 5-Friday rent pay) and shares what's still due up to then evenly over
// the paydays left, less what's in the account now. So the account builds up in the 4-Friday pays and
// is back to about $0 after each 5-Friday one. Rent at $400 a week, paid on the 19th: $1,730, $1,740,
// then $1,730 on the 5-Friday pay (back to $0: build.test.ts). Money moved in or out changes the next payday's amount.
// ---------------------------------------------------------------------------------------------

/** How far ahead a stretch can reach: a year of pays. With no bigger pay in it, the stretch is just this pay. */
const STRETCH_PAYS = 13;

/** Rounding for the pays before the bigger one: the account's own (`Account.round`), else $10. */
export const buildStep = (b: Budget, accountId: string): Cents => b.accounts.find((a) => a.id === accountId)?.round || 1000;

/**
 * One payday's amount. `needs[0]` is this pay's bills, then the pays after it; `balance` is what's in the
 * account the day before payday. The stretch ends at the first pay needing more than `average`. Its last
 * pay sends exactly what's left to find; earlier ones send an even share, rounded to `step`, and never
 * less than their own bills.
 */
export function buildAt(needs: Cents[], balance: Cents, average: Cents, step: Cents): Cents {
  let end = needs.findIndex((n) => n > average);
  if (end < 0) end = 0;
  const due = needs.slice(0, end + 1).reduce((t, n) => t + n, 0) - balance;
  if (end === 0) return Math.max(0, due);
  const share = Math.round(due / (end + 1) / step) * step;
  return Math.max(0, share, needs[0] - balance);
}

/** Build-up amounts pay by pay from the balance you entered (as Steady's run: `steady.ts`). Cached. */
function buildRun(b: Budget, accountId: string, today: ISODate, useBalance = true): Run {
  return cached(b, runKey(b, 'build', accountId, today, useBalance), () => {
    const start = runStart(b, accountId, today, useBalance);
    const count = runLength(start.pay, today, b.settings);
    const { slots, out } = window(b, accountId, start.pay, count + STRETCH_PAYS);
    const idx = { i: 0 };
    const needs = slots.slice(0, -1).map((x, i) => between(out, x.date, slots[i + 1].date, idx).reduce((t, o) => t + o.amount, 0));
    let bal = start.bal - fundedOut(b, accountId, addDays(start.cursor, 1), addDays(start.pay.start, -1)).reduce((t, o) => t + o.amount, 0);
    const average = averageNeed(b, accountId);
    const step = buildStep(b, accountId);
    const amounts = new Map<string, Cents>();
    for (let i = 0; i < count; i++) {
      const amt = buildAt(needs.slice(i, i + STRETCH_PAYS), bal, average, step);
      amounts.set(slots[i].date, amt);
      bal += (slots[i].fixed ?? amt) - needs[i];
    }
    return { first: slots[0].date, amounts };
  });
}

/** What a Build up account's payday sends (before any one-pay adjustment). */
export function buildFor(b: Budget, accountId: string, p: Period, today: ISODate = todayISO()): Cents {
  return fromRun(b, accountId, p, today, buildRun, () => Math.round(averageNeed(b, accountId)));
}

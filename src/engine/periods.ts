import { addDays, dateInMonth, diffDays, toDate, weekday, type ISODate } from '../core/dates';
import type { Budget, Settings } from '../core/types';

// ---------- Paydays and pay periods ----------

/** What sets the paydays: the day of the month, the weekend rules, and any paydays that really moved. */
export type PayRules = Pick<Settings, 'paydayDay' | 'saturday' | 'sunday'> & Pick<Partial<Settings>, 'paydayMoves'>;

function monthKey(year: number, month0: number): string {
  const y = year + Math.floor(month0 / 12);
  const m = ((month0 % 12) + 12) % 12;
  return `${y}-${String(m + 1).padStart(2, '0')}`;
}

/** The actual pay date for a given month, after weekend adjustment (or the day it really arrived, if recorded). */
export function paydayFor(year: number, month0: number, s: PayRules): ISODate {
  const moved = s.paydayMoves?.[monthKey(year, month0)];
  if (moved) return moved;
  const nominal = dateInMonth(year, month0, s.paydayDay);
  const wd = weekday(nominal);
  if (wd === 6) return addDays(nominal, s.saturday === 'friday' ? -1 : 2);
  if (wd === 0) return addDays(nominal, s.sunday === 'friday' ? -2 : 1);
  return nominal;
}

export interface Period {
  start: ISODate; // payday
  end: ISODate; // day before the next payday
  nextPayday: ISODate;
  days: number;
}

export function monthIndex(iso: ISODate): [number, number] {
  const d = toDate(iso);
  return [d.getUTCFullYear(), d.getUTCMonth()];
}

// Pay periods only depend on the date and the payday rules, and get asked for thousands of times
// while projecting, so remember them.
const periodCache = new Map<string, Period>();

/** The pay period (payday → day before next payday) that contains `date`. */
export function periodContaining(date: ISODate, s: PayRules): Period {
  const key = `${date}|${s.paydayDay}|${s.saturday}|${s.sunday}|${s.paydayMoves ? JSON.stringify(s.paydayMoves) : ''}`;
  const hit = periodCache.get(key);
  if (hit) return hit;
  if (periodCache.size > 50_000) periodCache.clear();
  const p = computePeriod(date, s);
  periodCache.set(key, p);
  return p;
}

function computePeriod(date: ISODate, s: PayRules): Period {
  const [y, m] = monthIndex(date);
  // The latest payday on or before `date`. Weekend rules can move a payday into the next month (the 31st
  // on a Saturday → Monday the 2nd) or back into the one before (the 1st on a Sunday → Friday), so the
  // months either side are checked too.
  let startMonth = m - 2;
  for (let k = m - 1; k <= m + 1; k++) if (paydayFor(y, k, s) <= date) startMonth = k;
  const start = paydayFor(y, startMonth, s);
  const nextPayday = paydayFor(y, startMonth + 1, s);
  return { start, end: addDays(nextPayday, -1), nextPayday, days: diffDays(start, nextPayday) };
}

/** The pay period the budget is on now: today's, or the one at the budget start date if that's later. */
export function budgetPeriod(b: Pick<Budget, 'settings'>, today: ISODate): Period {
  const cur = periodContaining(today, b.settings);
  const start = b.settings.budgetStart;
  return start && cur.start < start ? periodContaining(start, b.settings) : cur;
}

/**
 * The budget's first pay: the first payday on or after the budget start . With no
 * balance entered, every projection starts here, from what the pay before it left, so the numbers stay
 * put as days pass (they don't restart when payday arrives). No start date: the next pay after today.
 */
export function firstBudgetPay(b: Pick<Budget, 'settings'>, today: ISODate): Period {
  const s = b.settings;
  if (!s.budgetStart) return shiftPeriod(periodContaining(today, s), 1, s);
  const p = periodContaining(s.budgetStart, s);
  return p.start < s.budgetStart ? shiftPeriod(p, 1, s) : p;
}

/**
 * The next pay still to come, never before the budget start. Includes today's pay while it is still
 * payday (pay often lands late in the day); from the day after, that pay is treated as already split.
 */
export function upcomingPayPeriod(b: Pick<Budget, 'settings'>, today: ISODate): Period {
  const p = budgetPeriod(b, today);
  return p.start >= today ? p : shiftPeriod(p, 1, b.settings);
}

/** Move `n` pay periods forward (or back, if negative). */
export function shiftPeriod(p: Period, n: number, s: PayRules): Period {
  let cur = p;
  for (let i = 0; i < Math.abs(n); i++) {
    cur = n > 0 ? periodContaining(cur.nextPayday, s) : periodContaining(addDays(cur.start, -1), s);
  }
  return cur;
}

// ---------- Paydays that moved ----------

/** A payslip dated within this many days of the usual payday is that payday, arriving early or late. */
const MOVE_DAYS = 6;

/** Move everything kept for one pay (its pay, payslip and one-pay adjustments) to that pay's new start date. */
function rekeyPay(b: Budget, from: ISODate, to: ISODate): void {
  if (from === to) return;
  for (const map of [b.payActuals, b.payslips, b.overrides, b.autoBalanced, b.splitSent] as (Record<ISODate, unknown> | undefined)[]) {
    if (!map || !(from in map)) continue;
    if (!(to in map)) map[to] = map[from];
    delete map[from];
  }
  if (b.settings.budgetStart === from) b.settings.budgetStart = to;
}

/**
 * Pay arrived on `payDay`. If that's a few days off the usual payday (e.g. the 18th, before a holiday on
 * the 19th), that payday moves to it: the pay before ends a day sooner and this one starts a day sooner,
 * and both are worked out on their real dates from then on. Returns the start of the pay it belongs to.
 */
export function recordPayday(b: Budget, payDay: ISODate): ISODate {
  const s = b.settings;
  const p = periodContaining(payDay, s);
  if (p.start === payDay) return payDay;
  const usual = diffDays(payDay, p.nextPayday) <= MOVE_DAYS ? p.nextPayday : diffDays(p.start, payDay) <= MOVE_DAYS ? p.start : undefined;
  if (!usual) return p.start; // nowhere near a payday: counts for the pay it falls in
  const [y, m] = monthIndex(usual);
  for (let k = m - 1; k <= m + 1; k++) {
    if (paydayFor(y, k, s) !== usual) continue;
    s.paydayMoves = { ...(s.paydayMoves ?? {}), [monthKey(y, k)]: payDay };
    rekeyPay(b, usual, payDay);
    return payDay;
  }
  return p.start;
}

/** Forget that a payday moved (e.g. its payslip was removed): it goes back to the usual day. */
export function clearPaydayMove(b: Budget, start: ISODate): void {
  const s = b.settings;
  const key = Object.keys(s.paydayMoves ?? {}).find((k) => s.paydayMoves![k] === start);
  if (!key) return;
  delete s.paydayMoves![key];
  const [y, m] = key.split('-').map(Number);
  rekeyPay(b, start, paydayFor(y, m - 1, s));
}

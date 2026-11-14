import { addDays, diffDays, type ISODate } from './dates';
import { convert, isSetAside, itemDates, skippedDates, type Period } from './engine';
import type { Account, Budget, Cents, Item } from './types';

/** A weekly cost shown in the planner's weeks view. */
export interface WeeklyCoverage {
  item: Item;
  account?: Account;
  dates: ISODate[];
  /** Dates skipped because they land too close to payday. */
  skipped: ISODate[];
  /** Days the last one has to last until the next payday (1 = the day before payday). */
  lastCovers: number;
  /** Total of this pay's payments (count × amount). */
  total: Cents;
  /** What this pay actually uses, by days: weekly × period days ÷ 7 (the last one may mostly cover next pay). */
  uses: Cents;
  /** A normal month's total (weekly × 365.25 ÷ 7 ÷ 12). */
  monthAverage: Cents;
  /** uses − monthAverage: positive = more than a normal month. */
  overUnder: Cents;
}

/** Weekly costs switched on for the weeks view ("Show in Weeks this pay"). */
export function weeklyCoverage(b: Budget, period: Period): WeeklyCoverage[] {
  return b.items
    .filter((i) => i.frequency === 'weekly' && i.showInWeeks && !isSetAside(i))
    .map((item) => {
      const dates = itemDates(item, period.start, period.end, b.settings);
      const skipped = skippedDates(item, period.start, period.end, b.settings);
      const total = item.amount * dates.length;
      const uses = Math.round((item.amount * period.days) / 7);
      const monthAverage = convert(item.amount, 'weekly', 'month');
      return {
        item, account: b.accounts.find((a) => a.id === item.accountId), dates, skipped,
        lastCovers: dates.length ? diffDays(dates[dates.length - 1], period.nextPayday) : 0,
        total, uses, monthAverage, overUnder: uses - monthAverage,
      };
    })
    .filter((w) => w.dates.length > 0);
}

/** Calendar weeks (Mon–Sun) spanning a pay period through to the next payday. */
export function calendarWeeks(period: Period): ISODate[][] {
  const mondayOf = (d: ISODate) => addDays(d, -((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7));
  const weeks: ISODate[][] = [];
  for (let d = mondayOf(period.start); d <= period.nextPayday; d = addDays(d, 7)) {
    weeks.push(Array.from({ length: 7 }, (_, i) => addDays(d, i)));
  }
  return weeks;
}

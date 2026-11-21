import { addDays, dateInMonth, diffDays, toDate, type ISODate } from '../core/dates';
import type { Item, Settings } from '../core/types';
import { monthIndex, periodContaining } from './periods';

// ---------- Occurrences ----------

/** Every date `item` happens between start and end (inclusive). */
export function occurrences(item: Pick<Item, 'frequency' | 'start' | 'end'>, from: ISODate, to: ISODate): ISODate[] {
  const lo = from > item.start ? from : item.start;
  const hi = item.end && item.end < to ? item.end : to;
  if (lo > hi) return [];
  const out: ISODate[] = [];

  if (item.frequency === 'once') {
    if (item.start >= lo && item.start <= hi) out.push(item.start);
    return out;
  }

  if (item.frequency === 'weekly' || item.frequency === 'fortnightly') {
    const step = item.frequency === 'weekly' ? 7 : 14;
    const gap = diffDays(item.start, lo);
    let d = addDays(item.start, Math.ceil(gap / step) * step);
    while (d <= hi) { out.push(d); d = addDays(d, step); }
    return out;
  }

  const anchor = toDate(item.start);
  const day = anchor.getUTCDate();
  const [ly, lm] = monthIndex(lo);
  const [hy, hm] = monthIndex(hi);
  for (let i = ly * 12 + lm; i <= hy * 12 + hm; i++) {
    const y = Math.floor(i / 12);
    const m = i % 12;
    if (item.frequency === 'yearly' && m !== anchor.getUTCMonth()) continue;
    const d = dateInMonth(y, m, day);
    if (d >= lo && d <= hi) out.push(d);
  }
  return out;
}

/** Days from `date` until the next payday after it. */
export function daysToPayday(date: ISODate, s: Settings): number {
  return diffDays(date, periodContaining(date, s).nextPayday);
}

/** When a cost really happens: its occurrences, minus any skipped for landing too close to payday. */
export function itemDates(item: Pick<Item, 'frequency' | 'start' | 'end' | 'skipIfWithin'>, from: ISODate, to: ISODate, s: Settings): ISODate[] {
  const dates = occurrences(item, from, to);
  const skip = item.skipIfWithin;
  return skip ? dates.filter((d) => daysToPayday(d, s) > skip) : dates;
}

/** The occurrences that get skipped because they land within `skipIfWithin` days of payday. */
export function skippedDates(item: Pick<Item, 'frequency' | 'start' | 'end' | 'skipIfWithin'>, from: ISODate, to: ISODate, s: Settings): ISODate[] {
  const skip = item.skipIfWithin;
  return skip ? occurrences(item, from, to).filter((d) => daysToPayday(d, s) <= skip) : [];
}

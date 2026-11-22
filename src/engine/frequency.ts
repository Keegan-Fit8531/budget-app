import type { Cents, Frequency } from '../core/types';

// ---------- Frequency conversion ----------

export type View = 'week' | 'fortnight' | 'month' | 'year';

// A year is 365.25 days = 52.18 weeks, not 52: some years have 53 rent days. Using 52 would make
// weekly costs look ~0.35% cheaper per month, and a "steady" amount would slowly run its buffer down.
const WEEKS_PER_YEAR = 365.25 / 7;
const PER_WEEK: Record<Frequency, number> = {
  weekly: 1, fortnightly: 1 / 2, monthly: 12 / WEEKS_PER_YEAR, yearly: 1 / WEEKS_PER_YEAR, once: 0,
};
const WEEKS_IN: Record<View, number> = { week: 1, fortnight: 2, month: WEEKS_PER_YEAR / 12, year: WEEKS_PER_YEAR };

/** Convert an amount at one frequency to the long-run average for another view. */
export function convert(amount: Cents, freq: Frequency, view: View): Cents {
  return Math.round(amount * PER_WEEK[freq] * WEEKS_IN[view]);
}

/** Convert an amount entered per `view` back into a per-`freq` amount. */
export function convertFromView(amount: Cents, view: View, freq: Exclude<Frequency, 'once'>): Cents {
  return Math.round((amount / WEEKS_IN[view]) / PER_WEEK[freq]);
}

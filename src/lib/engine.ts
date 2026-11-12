import {
  addDays, dateInMonth, diffDays, toDate, todayISO, weekday, type ISODate,
} from './dates';
import { balanceOn, depositFor, exactNeed, modeOf, topsUp } from './balances';
import { accountHasPlans, debtPaymentsIn } from './debts';
import { accountHasGoals, savingsNeedIn } from './savings';
import type { Account, Budget, Cents, Frequency, Item, Settings } from './types';

// ---------- Paydays and pay periods ----------

/** The actual pay date for a given month, after weekend adjustment. */
export function paydayFor(year: number, month0: number, s: Pick<Settings, 'paydayDay' | 'saturday' | 'sunday'>): ISODate {
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

function monthIndex(iso: ISODate): [number, number] {
  const d = toDate(iso);
  return [d.getUTCFullYear(), d.getUTCMonth()];
}

// Pay periods only depend on the date and the payday rules, and get asked for thousands of times
// while projecting, so remember them.
const periodCache = new Map<string, Period>();

/** The pay period (payday → day before next payday) that contains `date`. */
export function periodContaining(date: ISODate, s: Pick<Settings, 'paydayDay' | 'saturday' | 'sunday'>): Period {
  const key = `${date}|${s.paydayDay}|${s.saturday}|${s.sunday}`;
  const hit = periodCache.get(key);
  if (hit) return hit;
  if (periodCache.size > 50_000) periodCache.clear();
  const p = computePeriod(date, s);
  periodCache.set(key, p);
  return p;
}

function computePeriod(date: ISODate, s: Pick<Settings, 'paydayDay' | 'saturday' | 'sunday'>): Period {
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

/** The next pay still to come (its payday is after today), never before the budget start. */
export function upcomingPayPeriod(b: Pick<Budget, 'settings'>, today: ISODate): Period {
  const p = budgetPeriod(b, today);
  return p.start > today ? p : shiftPeriod(p, 1, b.settings);
}

/** Move `n` pay periods forward (or back, if negative). */
export function shiftPeriod(p: Period, n: number, s: Pick<Settings, 'paydayDay' | 'saturday' | 'sunday'>): Period {
  let cur = p;
  for (let i = 0; i < Math.abs(n); i++) {
    cur = n > 0 ? periodContaining(cur.nextPayday, s) : periodContaining(addDays(cur.start, -1), s);
  }
  return cur;
}

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

// ---------- Period plan ----------

export interface Due { item: Item; date: ISODate }

export interface AccountPlan {
  account: Account;
  /** What payday sends in this period. */
  funded: Cents;
  /** What the account's items take out during this period. */
  need: Cents;
  /** funded − need (positive = spare). Null when the account has no items (e.g. an external payment). */
  diff: Cents | null;
  /** Estimated balance at the end of the period, when you've entered a balance for the account. */
  endBalance?: Cents;
  /** Set when this pay's amount was adjusted for this pay only (e.g. by Balance this pay). */
  usual?: Cents;
  dues: Due[];
  /** Explanation like "5 × $200 weekly". */
  breakdown: { item: Item; count: number }[];
}

export interface PeriodPlan {
  period: Period;
  pay: Cents;
  payIsActual: boolean;
  /** When there's no payslip yet: the period whose actual pay is used as the estimate. */
  payEstimateFrom?: ISODate;
  totalSplit: Cents;
  leftover: Cents;
  accounts: AccountPlan[];
  dues: Due[];
}

export function isAuto(b: Budget, accountId: string): boolean {
  return modeOf(b.split.find((l) => l.accountId === accountId)) !== 'fixed';
}

export function planFor(b: Budget, period: Period, today: ISODate = todayISO()): PeriodPlan {
  const actual = b.payActuals[period.start];
  // No payslip for this period yet: plan with the most recent pay received before it.
  const prevKey = actual === undefined ? Object.keys(b.payActuals).filter((k) => k < period.start).sort().pop() : undefined;
  const pay = actual ?? (prevKey ? b.payActuals[prevKey] : b.settings.expectedPay);
  const live = b.accounts.filter((a) => !a.archived);
  const payId = b.settings.payAccountId;

  // First work out what each account's costs need this period…
  const allDues: Due[] = [];
  const base = live.map((account) => {
    const items = b.items.filter((i) => i.accountId === account.id);
    const dues: Due[] = [];
    const breakdown = items.map((item) => {
      const dates = itemDates(item, period.start, period.end, b.settings);
      dates.forEach((date) => dues.push({ item, date }));
      return { item, count: dates.length };
    }).filter((x) => x.count > 0);
    // Debt plan payments and savings goals linked to this account count as its costs too.
    for (const p of debtPaymentsIn(b, account.id, period.start, period.end)) {
      const item: Item = {
        id: `${p.plan.id}@${p.date}`, name: p.plan.name, amount: p.amount,
        frequency: 'once', start: p.date, accountId: account.id,
      };
      dues.push({ item, date: p.date });
      breakdown.push({ item, count: 1 });
    }
    const saving = savingsNeedIn(b, account.id, period.start);
    if (saving > 0) {
      const item: Item = { id: `save-${account.id}`, name: 'Savings goal', amount: saving, frequency: 'once', start: period.start, accountId: account.id };
      dues.push({ item, date: period.start });
      breakdown.push({ item, count: 1 });
    }
    dues.sort((x, y) => x.date.localeCompare(y.date));
    allDues.push(...dues);
    const need = dues.reduce((s, d) => s + d.item.amount, 0);
    // …then what payday sends: the same amount the balance projections use (one source of truth).
    const funded = account.id === payId ? 0 : depositFor(b, account.id, period, today);
    const hasCosts = items.length > 0 || accountHasPlans(b, account.id) || accountHasGoals(b, account.id);
    return { account, items, dues, breakdown, need, funded, hasCosts };
  });

  const totalSplit = base.filter((x) => x.account.id !== payId).reduce((s, x) => s + x.funded, 0);
  const leftover = pay - totalSplit;

  const accounts = base.map(({ account, dues, breakdown, need, funded, hasCosts }): AccountPlan => {
    const f = account.id === payId ? leftover : funded;
    // With a balance entered, "short" means the account would actually go below $0 by the period's end.
    // Steady, or exact that tops up, with no balance entered: what it's projected to hold by then.
    const entry = b.balances?.[account.id];
    const tracked = account.id !== payId && (entry ? account.kind === 'bank'
      : modeOf(b.split.find((l) => l.accountId === account.id)) === 'smooth' || topsUp(b, account.id));
    const endBalance = tracked ? balanceOn(b, account.id, period.end, today) : undefined;
    // A one-pay adjustment to a debt changes what's paid, not what's "due", so don't call it short.
    const isDebt = (b.debts ?? []).some((d) => d.accountId === account.id);
    const adjusted = b.overrides?.[period.start]?.[account.id] !== undefined;
    const diff = endBalance !== undefined ? endBalance : adjusted && isDebt ? null : hasCosts ? f - need : null;
    return { account, funded: f, need, diff, endBalance, dues, breakdown, usual: adjusted ? depositFor(b, account.id, period, today, { usual: true }) : undefined };
  });
  allDues.sort((x, y) => x.date.localeCompare(y.date));
  return { period, pay, payIsActual: actual !== undefined, payEstimateFrom: prevKey, totalSplit, leftover, accounts, dues: allDues };
}

/** Steady per-pay amount for an account: its items' long-run monthly average. */
export function averageNeed(b: Budget, accountId: string): Cents {
  const mine = b.items.filter((i) => i.accountId === accountId && i.frequency !== 'once');
  let items = mine.filter((i) => !i.skipIfWithin).reduce((s, i) => s + convert(i.amount, i.frequency, 'month'), 0);
  // Costs with a skip-near-payday rule: count the real dates over the next 12 pays.
  const skippy = mine.filter((i) => i.skipIfWithin);
  if (skippy.length) {
    const first = periodContaining(todayISO(), b.settings);
    const last = shiftPeriod(first, 11, b.settings);
    const total = skippy.reduce((s, i) => s + i.amount * itemDates(i, first.start, last.end, b.settings).length, 0);
    items += Math.round(total / 12);
  }
  // Debts: average of the next 12 pays' plan payments. Savings: the per-pay amount goals need.
  let extra = 0;
  // (A card balance with no payment plans still gets paid off, e.g. a Mastercard balance.)
  const hasDebt = (b.debts ?? []).some((d) => d.accountId === accountId && !d.payroll);
  if (hasDebt || accountHasPlans(b, accountId) || accountHasGoals(b, accountId)) {
    let p = periodContaining(todayISO(), b.settings);
    let total = 0;
    for (let i = 0; i < 12; i++) {
      total += debtPaymentsIn(b, accountId, p.start, p.end).reduce((s, x) => s + x.amount, 0);
      total += savingsNeedIn(b, accountId, p.start);
      p = shiftPeriod(p, 1, b.settings);
    }
    extra = Math.round(total / 12);
  }
  return items + extra;
}

/** What payday sends to an account on average per month (auto accounts use their average need). */
export function averageSplit(b: Budget, accountId: string): Cents {
  const line = b.split.find((l) => l.accountId === accountId);
  if (!line) return 0;
  const mode = modeOf(line);
  // Steady: its usual amount (not the next pay's, which can include a one-off catch-up).
  return mode === 'exact' ? averageNeed(b, accountId) : mode === 'smooth' ? Math.ceil(averageNeed(b, accountId) / 100) * 100 : line.amount;
}

/**
 * Per pay (≈ per month), averaged over the next 12 pays: what's planned to be sent to an account and what
 * its costs take. Counts everything that's really planned: catch-ups, one-pay adjustments, goals that
 * stop at their date, debts that get paid off. Used by the Week / Fortnight / Month avg / Year views.
 */
export function plannedAverage(b: Budget, accountId: string, today: ISODate = todayISO()): { sent: Cents; need: Cents } {
  let p = upcomingPayPeriod(b, today);
  let sent = 0, need = 0;
  for (let i = 0; i < 12; i++) {
    sent += depositFor(b, accountId, p, today);
    need += exactNeed(b, accountId, p);
    p = shiftPeriod(p, 1, b.settings);
  }
  return { sent: Math.round(sent / 12), need: Math.round(need / 12) };
}


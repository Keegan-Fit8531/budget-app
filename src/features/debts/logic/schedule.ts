import { addDays, addMonths, fmtDay, todayISO, type ISODate } from '../../../core/dates';
import { periodContaining, shiftPeriod, type Period } from '../../../engine/periods';
import type { Cents, Debt, DebtPlan, PlanType, Settings } from '../../../core/types';
import { planEnds, gemPlan } from './gem/gem';
import { unplanned } from './amounts';

/** $1,234.56, for the warnings and reasons written in the debt files. */
export const fmt = (c: Cents) => `$${(c / 100).toLocaleString('en-NZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export interface Payment {
  date: ISODate; amount: Cents; debtId: string; planId: string;
  /** What the plan still owes after this payment. */
  after: Cents;
}

export interface PlanSchedule {
  plan: DebtPlan;
  /** A stand-in for purchases that aren't in any plan (Gem's "other purchases"). */
  synthetic?: boolean;
  payments: Payment[];
  /** Date of the last payment, if it gets paid off within the horizon. */
  paidOffBy?: ISODate;
  /** Interest-free deadline, for interest-free / equal / afterpay plans. */
  deadline?: ISODate;
  interest: Cents;
  warning?: string;
}

export const HORIZON = 120; // pay periods (~10 years)

/**
 * What payday sends a debt: a steady amount (undefined = whatever's recommended / due), or that plus
 * one-pay amounts by pay start (e.g. $1,500 extra to Gem in the March pay, from Optimise or the Planner).
 */
export interface DebtPay { usual?: Cents; byPeriod: Record<ISODate, Cents> }
export type PerPay = Cents | DebtPay | undefined;

/** The steady part of a PerPay. */
export function usualPay(perPay: PerPay): Cents | undefined {
  return typeof perPay === 'object' ? perPay.usual : perPay;
}

/**
 * What's paid in the pay starting `start`: its one-pay amount if it has one, else the steady amount.
 * `used` makes a pay's one-pay amount count once, even if two payment dates fall in that pay.
 */
export function payFor(perPay: PerPay, start: ISODate, used?: Set<ISODate>): Cents | undefined {
  if (typeof perPay !== 'object') return perPay;
  const o = perPay.byPeriod[start];
  if (o === undefined || used?.has(start)) return perPay.usual;
  used?.add(start);
  return o;
}

/** The last pay with a one-pay amount (so a zero steady amount doesn't stop the forecast before it). */
export function lastOneOff(perPay: PerPay): ISODate | undefined {
  return typeof perPay === 'object' ? Object.keys(perPay.byPeriod).sort().pop() : undefined;
}

export const PLAN_LABEL: Record<PlanType, string> = {
  'interest-free': 'Interest-free, any payments',
  equal: 'Equal payments',
  afterpay: 'Afterpay, 4 fortnightly',
  balance: 'Regular payment',
};

/** The first pay period whose payday is on or after `date` (money for a purchase comes from the next pay). */
export function firstPeriodFrom(date: ISODate, s: Settings): Period {
  const p = periodContaining(date, s);
  return p.start < date ? shiftPeriod(p, 1, s) : p;
}

/** Pay periods starting with the first payday on or after `from`, while `keep` says so (max HORIZON). */
function periodsFrom(from: ISODate, s: Settings, keep: (p: Period, i: number) => boolean): Period[] {
  const out: Period[] = [];
  let p = firstPeriodFrom(from, s);
  for (let i = 0; i < HORIZON && keep(p, i); i++) { out.push(p); p = shiftPeriod(p, 1, s); }
  return out;
}

/** The latest of some dates (unset ones ignored). */
const latest = (...ds: (ISODate | undefined)[]): ISODate => ds.filter((d): d is ISODate => !!d).sort().pop()!;

export function last<T>(xs: T[]): T | undefined {
  return xs[xs.length - 1];
}

/** Split `total` into `n` near-equal whole-cent parts that add up exactly. */
function spread(total: Cents, n: number): Cents[] {
  const base = Math.floor(total / n);
  return Array.from({ length: n }, (_, i) => (i < total - base * n ? base + 1 : base));
}

export function planSchedule(debt: Debt, plan: DebtPlan, s: Settings): PlanSchedule {
  const pay = (date: ISODate, amount: Cents, after = 0): Payment => ({ date, amount, debtId: debt.id, planId: plan.id, after });
  const rem = plan.remaining;
  if (rem <= 0) return { plan, payments: [], interest: 0 };
  // Fill in what's left after each payment (non-interest plans: a running subtraction).
  const withAfter = (ps: Payment[]): Payment[] => {
    let left = rem;
    return ps.map((p) => { left = Math.max(0, left - p.amount); return { ...p, after: left }; });
  };

  if (plan.instalments?.length) {
    const sorted = [...plan.instalments].filter((i) => i.amount > 0).sort((a, b) => a.date.localeCompare(b.date));
    const payments = withAfter(sorted.map((i) => pay(i.date, i.amount)));
    return {
      plan, payments, paidOffBy: last(payments)?.date,
      deadline: plan.type === 'afterpay' ? last(payments)?.date : plan.ends ?? (plan.months ? addMonths(plan.purchaseDate, plan.months) : undefined),
      interest: 0,
    };
  }

  if (plan.type === 'afterpay') {
    // Instalments fall 2, 4, 6 and 8 weeks after purchase; the unpaid ones are the last few.
    const inst = Math.round(plan.original / 4);
    const dates = [1, 2, 3, 4].map((k) => addDays(plan.purchaseDate, 14 * k));
    const n = Math.min(4, Math.max(1, Math.ceil(rem / inst - 0.0001)));
    const due = dates.slice(4 - n).map((d) => (d < plan.asOf ? plan.asOf : d));
    const amounts = Array.from({ length: n }, (_, i) => (i === n - 1 ? rem - inst * (n - 1) : inst));
    const payments = withAfter(due.map((d, i) => pay(d, amounts[i])).filter((p) => p.amount > 0));
    return { plan, payments, paidOffBy: last(payments)?.date, deadline: dates[3], interest: 0 };
  }

  if (plan.type === 'equal') {
    const months = plan.months ?? 12;
    const each = Math.round(plan.original / months);
    const n = Math.max(1, Math.ceil(rem / each - 0.0001));
    const first = latest(addMonths(plan.purchaseDate, 1), plan.asOf, plan.startsOn);
    const periods = periodsFrom(first, s, (_, i) => i < n);
    const payments = withAfter(periods.map((p, i) => pay(p.start, i === n - 1 ? rem - each * (n - 1) : each)));
    return { plan, payments, paidOffBy: last(payments)?.date, deadline: plan.ends ?? addMonths(plan.purchaseDate, months), interest: 0 };
  }

  if (plan.type === 'interest-free') {
    const deadline = planEnds(plan); // the exact end date if you entered one, else purchase date + months
    const start = plan.asOf > plan.purchaseDate ? plan.asOf : plan.purchaseDate;
    const periods = periodsFrom(start, s, (p) => p.start < deadline);
    if (periods.length === 0) {
      return {
        plan, payments: [pay(firstPeriodFrom(start, s).start, rem, 0)], deadline, interest: 0,
        warning: 'The interest-free period has ended. Interest is now being charged on this.',
      };
    }
    const payments = withAfter(spread(rem, periods.length).map((a, i) => pay(periods[i].start, a)));
    return { plan, payments, paidOffBy: last(payments)?.date, deadline, interest: 0 };
  }

  // balance: a fixed payment each pay, with monthly interest if the debt has a rate.
  const each = plan.payment ?? 0;
  if (each <= 0) return { plan, payments: [], interest: 0, warning: 'Set how much to pay each pay to see a payoff date.' };
  const monthlyRate = (debt.rate ?? 0) / 100 / 12;
  let left = rem;
  let interest = 0;
  const payments: Payment[] = [];
  let p = firstPeriodFrom(latest(plan.asOf, plan.purchaseDate, plan.startsOn), s);
  for (let n = 0; n < HORIZON && left > 0; n++, p = shiftPeriod(p, 1, s)) {
    const i = Math.round(left * monthlyRate);
    interest += i;
    left += i;
    const amount = Math.min(each, left);
    left -= amount;
    payments.push(pay(p.start, amount, left));
    if (i >= each) {
      return { plan, payments: [], interest: 0, warning: `${'$'}${(each / 100).toFixed(2)} a pay doesn't cover the interest, so this never gets paid off.` };
    }
  }
  return {
    plan, payments, interest,
    paidOffBy: left <= 0 ? last(payments)?.date : undefined,
    warning: left > 0 ? 'At this payment it takes more than 10 years to pay off.' : undefined,
  };
}

/**
 * Each plan's payments. `perPay` is what payday sends to this debt (undefined = the recommended amount);
 * it only matters for cards like Gem where one payment is split across plans by the card's own rules.
 */
export function debtSchedules(debt: Debt, s: Settings, perPay?: PerPay): PlanSchedule[] {
  if (debt.rules === 'gem') return gemPlan(debt, s, perPay).schedules;
  const list = debt.plans.map((p) => planSchedule(debt, p, s));
  const other = unplanned(debt);
  if (other > 0 && debt.rules === 'mastercard') list.push(...mastercardBalanceSchedules(debt, s, other, perPay, list));
  else if (other > 0) list.push(otherBalanceSchedule(debt, s, other, perPay, list));
  return list;
}

/**
 * Mastercard-style cards (every purchase 3 months interest-free): the balance outside plans gets an
 * automatic 3-month clock from the day it was entered, and each later increase gets its own clock.
 * Payments go to the soonest-ending clock first. Spread evenly over the pays before each clock ends
 * when paying "what's due"; no interest unless a clock runs out with money still owed.
 */
export function mastercardPurchases(debt: Debt, other: Cents): { date: ISODate; amount: Cents }[] {
  const hist = [...(debt.history ?? [])].sort((a, b) => a.asOf.localeCompare(b.asOf));
  if (debt.balance && !hist.some((h) => h.asOf === debt.balance!.asOf)) hist.push({ amount: debt.balance.amount, asOf: debt.balance.asOf });
  const inc: { date: ISODate; amount: Cents }[] = [];
  let prev = 0;
  for (const h of hist) {
    if (h.amount > prev) inc.push({ date: h.asOf, amount: h.amount - prev });
    prev = h.amount;
  }
  if (!inc.length) inc.push({ date: debt.balance?.asOf ?? todayISO(), amount: other });
  // Payments since have cleared the oldest amounts first: keep only what's still owed, newest last.
  let excess = inc.reduce((t, x) => t + x.amount, 0) - other;
  for (const x of inc) { const take = Math.min(excess, x.amount); x.amount -= take; excess -= take; }
  return inc.filter((x) => x.amount > 0);
}

function mastercardBalanceSchedules(debt: Debt, s: Settings, other: Cents, perPayIn: PerPay, plans: PlanSchedule[]): PlanSchedule[] {
  const months = 3;
  const items = mastercardPurchases(debt, other).map((x, i) => {
    const plan: DebtPlan = {
      id: `${debt.id}-auto-${i}`, name: `Balance from ${fmtDay(x.date)}`, type: 'interest-free', months,
      original: x.amount, remaining: x.amount, asOf: x.date, purchaseDate: x.date, ends: addMonths(x.date, months),
    };
    return { plan, left: x.amount, payments: [] as Payment[], interest: 0, warned: '' };
  });
  // Payments start at the first payday on or after the day the balance was last checked: paydays before
  // that are already in it (otherwise a payday that's been counted as paid would be taken off again).
  const latest = items.reduce((m, x) => (x.plan.asOf > m ? x.plan.asOf : m), items[0]?.plan.asOf ?? '');
  const start = debt.balance && debt.balance.asOf > latest ? debt.balance.asOf : latest;
  const monthlyRate = (debt.rate ?? 0) / 100 / 12;
  const planPayments = plans.flatMap((x) => x.payments);
  let p = firstPeriodFrom(start, s);
  for (let n = 0; n < HORIZON && items.some((x) => x.left > 0); n++, p = shiftPeriod(p, 1, s)) {
    const live = items.filter((x) => x.left > 0).sort((a, b) => a.plan.ends!.localeCompare(b.plan.ends!));
    for (const x of live) {
      if (x.plan.ends! <= p.start) {
        if (!x.warned) x.warned = `${fmt(x.left)} was still owed when interest-free ended on ${x.plan.ends}, so interest is charged on it from then.`;
        const i = Math.round(x.left * monthlyRate); x.left += i; x.interest += i;
      }
    }
    const perPay = payFor(perPayIn, p.start);
    let room = perPay === undefined ? Infinity : Math.max(0, perPay - planPayments.filter((y) => y.date >= p.start && y.date <= p.end).reduce((t, y) => t + y.amount, 0));
    for (const x of live) {
      if (room <= 0) break;
      let due = x.left;
      if (perPay === undefined && x.plan.ends! > p.start) {
        // Spread over the pays left before this clock ends.
        let k = 0; for (let q = p; q.start < x.plan.ends! && k < HORIZON; q = shiftPeriod(q, 1, s)) k++;
        due = Math.ceil(x.left / Math.max(1, k));
      }
      const amount = Math.min(due, room, x.left);
      if (amount <= 0) continue;
      x.left -= amount; room -= amount;
      x.payments.push({ date: p.start, amount, debtId: debt.id, planId: x.plan.id, after: x.left });
    }
  }
  return items.map((x) => ({
    plan: x.plan, synthetic: true, payments: x.payments, interest: x.interest,
    deadline: x.plan.ends, paidOffBy: x.left <= 0 ? last(x.payments)?.date : undefined, warning: x.warned || undefined,
  }));
}

/**
 * The part of an entered balance that isn't in a plan (e.g. a Mastercard balance): paid down each
 * payday by what's left of the payday amount after plan payments, or in full when paying "what's due".
 */
function otherBalanceSchedule(debt: Debt, s: Settings, other: Cents, perPayIn: PerPay, plans: PlanSchedule[]): PlanSchedule {
  const start = debt.balance?.asOf ?? todayISO();
  const plan: DebtPlan = { id: `${debt.id}-other`, name: 'Balance', type: 'balance', original: other, remaining: other, asOf: start, purchaseDate: start };
  const monthlyRate = (debt.rate ?? 0) / 100 / 12;
  const planPayments = plans.flatMap((x) => x.payments);
  const payments: Payment[] = [];
  let left = other;
  let interest = 0;
  let p = firstPeriodFrom(start, s);
  for (let n = 0; n < HORIZON && left > 0; n++, p = shiftPeriod(p, 1, s)) {
    const i = n === 0 ? 0 : Math.round(left * monthlyRate); // a month passes before interest is charged
    interest += i; left += i;
    const planned = planPayments.filter((x) => x.date >= p.start && x.date <= p.end).reduce((t, x) => t + x.amount, 0);
    const perPay = payFor(perPayIn, p.start);
    const room = perPay === undefined ? left : Math.max(0, perPay - planned);
    const amount = Math.min(left, room);
    if (amount <= 0) {
      const more = lastOneOff(perPayIn);
      if (perPay !== undefined && perPay <= 0 && !(more && more > p.start)) break;
      continue;
    }
    left -= amount;
    payments.push({ date: p.start, amount, debtId: debt.id, planId: plan.id, after: left });
  }
  return {
    plan, synthetic: true, payments, interest,
    paidOffBy: left <= 0 ? last(payments)?.date : undefined,
    warning: left > 0 && payments.length ? 'At this payday amount the balance takes more than 10 years to clear.' : undefined,
  };
}

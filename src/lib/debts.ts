import { addDays, addMonths, dateInMonth, fmtDay, ordinal, type ISODate } from './dates';
import { periodContaining, shiftPeriod, type Period } from './engine';
import type { Budget, Cents, Debt, DebtPlan, PlanType, Settings } from './types';

const fmt = (c: Cents) => `$${(c / 100).toLocaleString('en-NZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

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

const HORIZON = 120; // pay periods (~10 years)

export const PLAN_LABEL: Record<PlanType, string> = {
  'interest-free': 'Interest-free, any payments',
  equal: 'Equal payments',
  afterpay: 'Afterpay, 4 fortnightly',
  balance: 'Regular payment',
};

/** The first pay period whose payday is on or after `date` (money for a purchase comes from the next pay). */
function firstPeriodFrom(date: ISODate, s: Settings): Period {
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

function last<T>(xs: T[]): T | undefined {
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
    const first = addMonths(plan.purchaseDate, 1);
    const periods = periodsFrom(first > plan.asOf ? first : plan.asOf, s, (_, i) => i < n);
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
  let p = firstPeriodFrom(plan.asOf > plan.purchaseDate ? plan.asOf : plan.purchaseDate, s);
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
export function debtSchedules(debt: Debt, s: Settings, perPay?: Cents): PlanSchedule[] {
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
  if (!inc.length) inc.push({ date: debt.balance?.asOf ?? new Date().toISOString().slice(0, 10), amount: other });
  // Payments since have cleared the oldest amounts first: keep only what's still owed, newest last.
  let excess = inc.reduce((t, x) => t + x.amount, 0) - other;
  for (const x of inc) { const take = Math.min(excess, x.amount); x.amount -= take; excess -= take; }
  return inc.filter((x) => x.amount > 0);
}

function mastercardBalanceSchedules(debt: Debt, s: Settings, other: Cents, perPay: Cents | undefined, plans: PlanSchedule[]): PlanSchedule[] {
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
function otherBalanceSchedule(debt: Debt, s: Settings, other: Cents, perPay: Cents | undefined, plans: PlanSchedule[]): PlanSchedule {
  const start = debt.balance?.asOf ?? new Date().toISOString().slice(0, 10);
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
    const room = perPay === undefined ? left : Math.max(0, perPay - planned);
    const amount = Math.min(left, room);
    if (amount <= 0) { if (perPay !== undefined && perPay <= 0) break; continue; }
    left -= amount;
    payments.push({ date: p.start, amount, debtId: debt.id, planId: plan.id, after: left });
  }
  return {
    plan, synthetic: true, payments, interest,
    paidOffBy: left <= 0 ? last(payments)?.date : undefined,
    warning: left > 0 && payments.length ? 'At this payday amount the balance takes more than 10 years to clear.' : undefined,
  };
}

/** What payday sends to a debt: its fixed amount, or undefined when it's set to pay what's needed. */
export function debtPerPay(b: Budget, debt: Debt): Cents | undefined {
  if (debt.payroll) return debt.payroll.perPay; // taken from salary each payday
  const line = b.split.find((l) => l.accountId === debt.accountId);
  const mode = line?.mode ?? (line?.auto ? 'exact' : 'fixed');
  return mode === 'fixed' ? (line?.amount ?? 0) : undefined;
}

/** What the payment plans still owe, added up. */
export function plannedOwed(debt: Debt): Cents {
  return debt.plans.reduce((t, p) => t + Math.max(0, p.remaining), 0);
}

/** Outstanding balance: the one you entered if there is one, otherwise the plans added up. */
export function owed(debt: Debt): Cents {
  return debt.balance ? debt.balance.amount : plannedOwed(debt);
}

/** Part of the entered balance that isn't covered by any plan (e.g. older purchases). */
export function unplanned(debt: Debt): Cents {
  return Math.max(0, owed(debt) - plannedOwed(debt));
}

/** Debt payments due to an account (via its debts) within a date range. */
export function debtPaymentsIn(b: Budget, accountId: string, from: ISODate, to: ISODate): { debt: Debt; plan: DebtPlan; date: ISODate; amount: Cents }[] {
  const out: { debt: Debt; plan: DebtPlan; date: ISODate; amount: Cents }[] = [];
  for (const debt of b.debts ?? []) {
    if (debt.accountId !== accountId) continue;
    for (const sch of debtSchedules(debt, b.settings, debtPerPay(b, debt))) {
      for (const p of sch.payments) if (p.date >= from && p.date <= to) out.push({ debt, plan: sch.plan, date: p.date, amount: p.amount });
    }
  }
  return out;
}

export function accountHasPlans(b: Budget, accountId: string): boolean {
  return (b.debts ?? []).some((d) => d.accountId === accountId && d.plans.some((p) => p.remaining > 0));
}

/** Suggested plan type for a new purchase on a card with known rules. */
export function suggestPlan(debt: Debt, amount: Cents): { type: PlanType; months?: number } {
  if (debt.rules === 'afterpay' || debt.kind === 'bnpl') return { type: 'afterpay' };
  if (debt.rules === 'mastercard') return { type: 'interest-free', months: 3 };
  if (debt.rules === 'gem') return amount >= 25000 ? { type: 'interest-free', months: 6 } : { type: 'balance' };
  return { type: 'balance' };
}

/** What a debt is forecast to owe at the end of `date`, from its plans (unplanned balance stays as it is). */
export function projectedOwed(debt: Debt, s: Settings, date: ISODate, perPay?: Cents): Cents {
  const schedules = debtSchedules(debt, s, perPay);
  let total = schedules.some((x) => x.synthetic) ? 0 : unplanned(debt);
  for (const sch of schedules) {
    let left = Math.max(0, sch.plan.remaining);
    for (const p of sch.payments) { if (p.date <= date) left = p.after; else break; }
    total += left;
  }
  return total;
}

/** What a debt owed at the end of `date` according to its recorded history, if known. */
export function historyOwed(debt: Debt, date: ISODate): Cents | undefined {
  let v: Cents | undefined;
  for (const h of debt.history ?? []) { if (h.asOf <= date) v = h.amount; else break; }
  return v;
}

/** Record today's amount owed in the debt's history (one entry per day; call after any change). */
export function recordHistory(debt: Debt, today: ISODate): void {
  const amount = owed(debt);
  const hist = (debt.history ?? []).filter((h) => h.asOf !== today);
  hist.push({ amount, asOf: today });
  hist.sort((a, b) => a.asOf.localeCompare(b.asOf));
  debt.history = hist.slice(-500);
}

export interface Applied { planId: string; planName: string; date: ISODate; amount: Cents; cleared: boolean }

/**
 * Apply a payment to a debt, paying off what's due soonest first (across all its plans).
 * Changes `debt` in place and returns what each part of the payment went to. Anything left over
 * (paying more than is scheduled) reduces an entered balance only.
 */
export function applyPayment(debt: Debt, amount: Cents, s: Settings, date: ISODate): { applied: Applied[]; leftover: Cents } {
  if (debt.rules === 'gem') return gemApply(debt, amount, date);
  // Paid on a payday: that's the payday's own payment, so the next one planned is the payday after
  // (dated the day after, the same way a payslip's loan deduction is, so it isn't counted twice).
  const asOf = periodContaining(date, s).start === date ? addDays(date, 1) : date;
  const due = debtSchedules(debt, s)
    .flatMap((sch) => sch.payments.map((p) => ({ plan: sch.plan, date: p.date, amount: p.amount })))
    .sort((a, b) => a.date.localeCompare(b.date) || a.plan.name.localeCompare(b.plan.name));
  let left = amount;
  const applied: Applied[] = [];
  for (const d of due) {
    if (left <= 0) break;
    const take = Math.min(left, d.amount);
    left -= take;
    const p = d.plan;
    if (p.instalments?.length) {
      const inst = p.instalments.find((i) => i.date === d.date && i.amount > 0);
      if (inst) inst.amount -= take;
      p.instalments = p.instalments.filter((i) => i.amount > 0);
      p.remaining = p.instalments.reduce((t, i) => t + i.amount, 0);
    } else {
      p.remaining = Math.max(0, p.remaining - take);
      p.asOf = asOf;
    }
    applied.push({ planId: p.id, planName: p.name, date: d.date, amount: take, cleared: take === d.amount });
  }
  if (debt.balance) debt.balance = { amount: Math.max(0, debt.balance.amount - amount), asOf };
  debt.plans = debt.plans.filter((p) => p.remaining > 0);
  recordHistory(debt, date);
  return { applied, leftover: left };
}

/**
 * Payments are automatic (Afterpay direct debit, card payments from payday), so anything scheduled
 * before today counts as paid. Returns true if anything changed.
 */
export function settleDue(debt: Debt, s: Settings, today: ISODate, perPay?: Cents): boolean {
  let paid = 0;
  for (const sch of debtSchedules(debt, s, perPay)) {
    const past = sch.payments.filter((p) => p.date < today);
    if (!past.length) continue;
    const p = sch.plan;
    const total = past.reduce((t, x) => t + x.amount, 0);
    paid += total;
    if (sch.synthetic) continue; // other purchases: comes off the entered balance below
    if (p.instalments?.length) {
      p.instalments = p.instalments.filter((i) => i.date >= today);
      p.remaining = p.instalments.reduce((t, i) => t + i.amount, 0);
    } else {
      p.remaining = last(past)!.after;
      p.asOf = today;
    }
  }
  if (!paid) return false;
  if (debt.balance && debt.balance.asOf < today) debt.balance = { amount: Math.max(0, debt.balance.amount - paid), asOf: today };
  debt.plans = debt.plans.filter((p) => p.remaining > 0);
  recordHistory(debt, today);
  return true;
}

// ---------------------------------------------------------------------------------------------
// Gem Visa (Latitude, NZ). Conditions of Use, October 2026, clause 14:
//   14.3 a payment is applied: (a) instalment amounts due → (b–c) fees/interest → (d–e) other
//   amounts due: balance transfers, cash, expired promotions, retail purchases → (f) anything not
//   yet due. Unexpired interest-free purchases are credited in order of their EXPIRY dates; other
//   transactions in the order they appeared. Instalment plans get extra payments last.
//   14.2 minimum payment = instalments due + the greater of 3% of the rest of the balance or $20.
// You can't direct a payment at one plan; this reproduces that split each payday.
// ---------------------------------------------------------------------------------------------

export function planEnds(p: DebtPlan): ISODate {
  return p.ends ?? addMonths(p.purchaseDate, p.months ?? 6);
}

interface Bucket {
  plan: DebtPlan;
  kind: 'instalment' | 'other' | 'promo';
  left: Cents;
  monthly: Cents;
  end: ISODate;
  synthetic?: boolean;
}

function gemBuckets(debt: Debt, start: ISODate): Bucket[] {
  const other = unplanned(debt);
  const out: Bucket[] = [];
  if (other > 0) {
    out.push({
      kind: 'other', left: other, monthly: 0, end: start, synthetic: true,
      plan: { id: `${debt.id}-other`, name: 'Other purchases', type: 'balance', original: other, remaining: other, asOf: start, purchaseDate: start },
    });
  }
  for (const p of [...debt.plans].sort((a, b) => a.purchaseDate.localeCompare(b.purchaseDate))) {
    if (p.remaining <= 0) continue;
    if (p.type === 'equal') out.push({ plan: p, kind: 'instalment', left: p.remaining, monthly: Math.round(p.original / (p.months ?? 12)), end: planEnds(p) });
    else if (p.type === 'interest-free') out.push({ plan: p, kind: 'promo', left: p.remaining, monthly: 0, end: planEnds(p) });
    else out.push({ plan: p, kind: 'other', left: p.remaining, monthly: 0, end: start });
  }
  return out;
}

/** Split one payment across the buckets in Gem's order. Mutates `left`; returns the amount each bucket got. */
function gemSplit(buckets: Bucket[], amount: Cents, date: ISODate): Map<Bucket, Cents> {
  const got = new Map<Bucket, Cents>();
  let pay = amount;
  const give = (b: Bucket, max: Cents) => {
    const x = Math.min(pay, max, b.left);
    if (x <= 0) return;
    b.left -= x; pay -= x; got.set(b, (got.get(b) ?? 0) + x);
  };
  const inst = buckets.filter((b) => b.kind === 'instalment');
  // (a) this month's instalment amounts
  for (const b of inst) give(b, b.monthly);
  // (d–e) other purchases, then interest-free plans that have already expired (oldest first)
  for (const b of buckets.filter((b) => b.kind === 'other')) give(b, Infinity);
  const promos = buckets.filter((b) => b.kind === 'promo');
  for (const b of promos.filter((b) => b.end <= date)) give(b, Infinity);
  // (f) unexpired interest-free plans, soonest expiry first
  for (const b of promos.filter((b) => b.end > date).sort((a, b) => a.end.localeCompare(b.end))) give(b, Infinity);
  // then extra off instalment plans
  for (const b of inst) give(b, Infinity);
  return got;
}

export interface GemPlanResult {
  schedules: PlanSchedule[];
  /** Paid each pay in the forecast. */
  perPay: Cents;
  /** Smallest steady amount each pay that clears every interest-free plan before it ends. */
  recommended: Cents;
  /** Gem's minimum payment (clause 14.2) for the coming statement. */
  minimum: Cents;
  /** This month's instalment amounts (they come out of every payment first). */
  instalmentsDue: Cents;
}

export function gemPlan(debt: Debt, s: Settings, perPay?: Cents): GemPlanResult {
  const dates = [debt.balance?.asOf, ...debt.plans.map((p) => p.asOf)].filter(Boolean) as ISODate[];
  const start = dates.sort()[dates.length - 1] ?? new Date().toISOString().slice(0, 10);
  const buckets = gemBuckets(debt, start);
  const inst = buckets.filter((b) => b.kind === 'instalment');
  const instalmentsDue = inst.reduce((t, b) => t + Math.min(b.left, b.monthly), 0);
  const rest = buckets.filter((b) => b.kind !== 'instalment').reduce((t, b) => t + b.left, 0);
  const minimum = instalmentsDue + (rest < 2000 ? rest : Math.max(2000, Math.round(rest * 0.03)));

  // Payment dates: each statement day (paying before the statement puts it all on the oldest plan),
  // or each payday if the card has no statement day set.
  const paydays: ISODate[] = [];
  if (debt.statementDay) {
    const [y, m] = [Number(start.slice(0, 4)), Number(start.slice(5, 7)) - 1];
    for (let i = 0; paydays.length < HORIZON && i < HORIZON + 2; i++) {
      const d = dateInMonth(y, m + i, debt.statementDay);
      if (d > start) paydays.push(d);
    }
  } else {
    let p = firstPeriodFrom(start, s);
    for (let i = 0; i < HORIZON; i++) { paydays.push(p.start); p = shiftPeriod(p, 1, s); }
  }

  // Recommended: instalments due + enough that, paying soonest-expiry first, each plan is clear in time.
  let cum = buckets.filter((b) => b.kind === 'other').reduce((t, b) => t + b.left, 0);
  let need = cum; // other purchases: clear them on the first payment
  for (const b of buckets.filter((b) => b.kind === 'promo').sort((a, b) => a.end.localeCompare(b.end))) {
    cum += b.left;
    const n = paydays.filter((d) => d < b.end).length;
    need = Math.max(need, n > 0 ? Math.ceil(cum / n) : cum);
  }
  const recommended = Math.ceil(Math.max(instalmentsDue + need, minimum) / 100) * 100;
  const amount = perPay ?? recommended;

  // Simulate each payday.
  const payments = new Map<Bucket, Payment[]>(buckets.map((b) => [b, []]));
  const warnings = new Map<Bucket, string>();
  for (const date of paydays) {
    if (buckets.every((b) => b.left <= 0) || amount <= 0) break;
    for (const b of buckets) {
      if (b.kind === 'promo' && b.left > 0 && b.end <= date && !warnings.has(b)) {
        warnings.set(b, `${fmt(b.left)} will still be owed when interest-free ends on ${b.end}, so interest is charged on it from then.`);
      }
    }
    for (const [b, x] of gemSplit(buckets, amount, date)) {
      payments.get(b)!.push({ date, amount: x, debtId: debt.id, planId: b.plan.id, after: b.left });
    }
  }
  const schedules: PlanSchedule[] = buckets.map((b) => {
    const ps = payments.get(b)!;
    return {
      plan: b.plan, synthetic: b.synthetic, payments: ps, interest: 0,
      paidOffBy: b.left <= 0 ? last(ps)?.date : undefined,
      deadline: b.kind === 'other' ? undefined : b.end,
      warning: warnings.get(b) ?? (b.left > 0 && ps.length > 0 ? `At ${fmt(amount)} a pay this isn't paid off within 10 years.` : undefined),
    };
  });
  return { schedules, perPay: amount, recommended, minimum, instalmentsDue };
}

/** Before the statement: Gem puts the payment on the oldest plan (by purchase date), then the next. */
function oldestFirst(buckets: Bucket[], amount: Cents): Map<Bucket, Cents> {
  const got = new Map<Bucket, Cents>();
  let pay = amount;
  for (const b of [...buckets].filter((x) => !x.synthetic).sort((x, y) => x.plan.purchaseDate.localeCompare(y.plan.purchaseDate)).concat(buckets.filter((x) => x.synthetic))) {
    const x = Math.min(pay, b.left);
    if (x <= 0) continue;
    b.left -= x; pay -= x; got.set(b, x);
  }
  return got;
}

/** True when paying this card on `date` comes before its statement (so it won't be split across plans). */
export function beforeStatement(debt: Debt, date: ISODate): boolean {
  return !!debt.statementDay && Number(date.slice(8, 10)) < debt.statementDay;
}

/** A payment you've made to Gem, split the way Gem splits it. */
function gemApply(debt: Debt, amount: Cents, date: ISODate): { applied: Applied[]; leftover: Cents } {
  const buckets = gemBuckets(debt, date);
  const got = debt.statementDay && Number(date.slice(8, 10)) < debt.statementDay
    ? oldestFirst(buckets, amount)
    : gemSplit(buckets, amount, date);
  const applied: Applied[] = [];
  let used = 0;
  for (const [b, x] of got) {
    used += x;
    applied.push({ planId: b.plan.id, planName: b.plan.name, date, amount: x, cleared: b.left === 0 });
    if (!b.synthetic) { b.plan.remaining = b.left; b.plan.asOf = date; }
  }
  if (debt.balance) debt.balance = { amount: Math.max(0, debt.balance.amount - amount), asOf: date };
  debt.plans = debt.plans.filter((p) => p.remaining > 0);
  recordHistory(debt, date);
  return { applied, leftover: amount - used };
}

// ---------------------------------------------------------------------------------------------
// Recommended payment per debt, for one pay period — each debt by the logic that suits it.
// ---------------------------------------------------------------------------------------------

export interface DebtAdvice {
  debt: Debt;
  /** What we recommend sending on this payday. */
  recommended: Cents;
  /** What payday is set to send now. */
  sending: Cents;
  /** Plain-English reason for the recommendation. */
  reason: string;
  /** The card's own minimum, when it has one. */
  minimum?: Cents;
  /** How "Use recommended" applies it: pay exactly what's due, or set a fixed amount. */
  apply: { mode: 'exact' } | { mode: 'fixed'; amount: Cents };
}

export function debtAdvice(b: Budget, debt: Debt, period: Period): DebtAdvice {
  const s = b.settings;
  const line = b.split.find((l) => l.accountId === debt.accountId);
  const fixed = debtPerPay(b, debt);
  const inPeriod = (perPay?: Cents) => debtSchedules(debt, s, perPay)
    .flatMap((x) => x.payments).filter((p) => p.date >= period.start && p.date <= period.end)
    .reduce((t, p) => t + p.amount, 0);
  const sending = fixed !== undefined ? fixed : inPeriod();
  const total = owed(debt);
  const base = { debt, sending };

  const balanceKnown = !!debt.balance || debt.plans.length > 0 || !!debt.history?.length;
  if (!balanceKnown) {
    return {
      ...base, recommended: sending, apply: { mode: 'fixed', amount: sending },
      reason: 'Enter what\u2019s owed (Update balance) to get a recommendation. Keeping your current amount for now.',
    };
  }
  if (total <= 0) return { ...base, recommended: 0, reason: 'Paid off.', apply: { mode: 'fixed', amount: 0 } };
  if (debt.payroll) {
    return { ...base, recommended: sending, apply: { mode: 'fixed', amount: sending },
      reason: 'Taken from your salary before pay reaches you, so it isn\u2019t part of the payday split.' };
  }

  if (debt.rules === 'gem') {
    const g = gemPlan(debt, s);
    return {
      ...base, recommended: g.recommended, minimum: g.minimum, apply: { mode: 'exact' },
      reason: `The steady amount that clears every interest-free plan before it expires, since Gem pays the soonest-expiring plan first.${debt.statementDay ? ` Pay it on or after the ${ordinal(debt.statementDay)} (statement day), not before.` : ''} Gem's minimum is ${fmt(g.minimum)}.`,
    };
  }

  const planned = inPeriod(undefined);
  const extra = unplanned(debt);

  if (debt.kind === 'bnpl' || debt.rules === 'afterpay') {
    return {
      ...base, recommended: planned + extra, apply: { mode: 'exact' },
      reason: planned
        ? `Exactly the instalments due ${fmtDay(period.start)} – ${fmtDay(period.end)}, so nothing's late.`
        : 'No instalments due this pay.',
    };
  }

  if (debt.kind === 'person' || debt.kind === 'loan') {
    if (debt.plans.length) {
      return { ...base, recommended: planned, apply: { mode: 'exact' }, reason: 'The repayment you set up, until it’s paid off.' };
    }
    const agreed = line?.amount ?? 0;
    return {
      ...base, recommended: Math.min(agreed, total), apply: { mode: 'fixed', amount: Math.min(agreed, total) },
      reason: agreed ? 'Your agreed amount each pay.' : 'Add an agreed amount to plan repayments.',
    };
  }

  // Other credit cards (e.g. Mastercard, each purchase 3 months interest-free).
  const planPart = debtSchedules(debt, s).filter((x) => !x.synthetic).flatMap((x) => x.payments)
    .filter((p) => p.date >= period.start && p.date <= period.end).reduce((t, p) => t + p.amount, 0);
  const balancePart = planned - planPart;
  const parts: string[] = [];
  if (planPart) parts.push(`${fmt(planPart)} keeps each interest-free purchase on track to clear before it ends`);
  if (balancePart) {
    const autos = debt.rules === 'mastercard' ? debtSchedules(debt, s).filter((x) => x.synthetic && x.deadline) : [];
    parts.push(autos.length
      ? `${fmt(balancePart)} spreads the balance over the pays before its 3 months interest-free ends (${autos.map((x) => fmtDay(x.deadline!)).join(', ')}), so no interest is charged`
      : `${fmt(balancePart)} pays off the balance in full, so no interest is charged`);
  }
  return {
    ...base, recommended: planned, apply: { mode: 'exact' },
    reason: parts.length ? `${parts.join('; ')}.` : extra ? 'The balance is already paid off by an earlier pay.' : 'Nothing due this pay.',
  };
}

/**
 * A payslip's student loan deduction: brings the payroll-deducted loan's balance down by it (once per
 * payday) and makes it the amount expected each payday from now on. Returns the loan it went to.
 */
export function applyPayrollDeduction(b: Budget, payday: ISODate, amount: Cents): Debt | undefined {
  const debt = (b.debts ?? []).find((d) => d.payroll && d.kind === 'loan');
  if (!debt || !debt.payroll || amount <= 0) return undefined;
  const applied = debt.payroll.applied ?? [];
  debt.payroll.perPay = amount;
  if (applied.includes(payday)) return debt;
  debt.payroll.applied = [...applied, payday].slice(-60);
  if (debt.balance && payday >= debt.balance.asOf) {
    const left = Math.max(0, debt.balance.amount - amount);
    // Dated the day after, so the payday's own deduction isn't counted again.
    debt.balance = { amount: left, asOf: addDays(payday, 1) };
    const hist = (debt.history ?? []).filter((h) => h.asOf !== payday);
    hist.push({ amount: left, asOf: payday });
    debt.history = hist.sort((x, y) => x.asOf.localeCompare(y.asOf)).slice(-500);
  }
  return debt;
}

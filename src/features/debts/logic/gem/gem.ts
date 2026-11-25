import { addDays, addMonths, dateInMonth, gemEndsFromMonthsLeft, todayISO, type ISODate } from '../../../../core/dates';
import { periodContaining, shiftPeriod } from '../../../../engine/periods';
import type { Cents, Debt, DebtPlan, PlanType, Settings } from '../../../../core/types';
import { owed, unplanned } from '../amounts';
import {
  type Payment, type PlanSchedule, HORIZON, type PerPay, usualPay, payFor, lastOneOff, firstPeriodFrom, last,
  debtSchedules, fmt,
} from '../schedule';
import { type Applied, rememberPaid, later, recordPaymentHistory } from '../payments';

/** Gem plan lengths you can pick (interest-free 6 months, or equal-payment deals). */
export const GEM_PLAN_MONTHS = [6, 12, 24, 36, 60] as const;

/** Gem: 6 months is interest-free any payments; 12+ is equal monthly payments. */
export function gemPlanType(months: number): PlanType {
  return months <= 6 ? 'interest-free' : 'equal';
}

/**
 * End date for a Gem plan from how many months are left (or the full length for a brand-new one),
 * using Gem's 20th-of-month cycle.
 */
export function gemPlanEnds(today: ISODate, monthsLeft: number): ISODate {
  return gemEndsFromMonthsLeft(today, monthsLeft);
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

/** Copy of buckets with leftovers scaled to the card balance (for the recommended pay only). */
function gemBucketsForRecommend(debt: Debt, start: ISODate): Bucket[] {
  const out = gemBuckets(debt, start).map((b) => ({ ...b, plan: { ...b.plan } }));
  const total = out.reduce((t, b) => t + b.left, 0);
  const bal = owed(debt);
  if (total > bal && total > 0 && bal >= 0) {
    const scale = bal / total;
    for (const b of out) b.left = Math.round(b.left * scale);
  }
  return out;
}

/**
 * What a statement on `date` needs so no plan is charged interest (as Latitude works it out): each equal-payment
 * plan's instalment, other purchases in full (they're charged interest), and each interest-free plan's balance
 * spread over the statements left before it ends. Never less than Gem's minimum (`minimum`, else 3% / $20).
 * Whole dollars, rounded up. It drops as plans are paid off: Gem at $245 now is $82 once only instalments are left.
 */
function gemDue(buckets: Bucket[], date: ISODate, statements: ISODate[], minimum?: Cents): Cents {
  let due = 0;
  for (const b of buckets) {
    if (b.left <= 0) continue;
    if (b.kind === 'instalment') due += Math.min(b.left, b.monthly);
    else if (b.kind === 'other' || b.end <= date) due += b.left;
    else due += Math.ceil(b.left / Math.max(1, statements.filter((d) => d >= date && d < b.end).length));
  }
  const inst = buckets.filter((b) => b.kind === 'instalment').reduce((t, b) => t + Math.min(Math.max(0, b.left), b.monthly), 0);
  const rest = buckets.filter((b) => b.kind !== 'instalment').reduce((t, b) => t + Math.max(0, b.left), 0);
  const min = minimum ?? inst + (rest < 2000 ? rest : Math.max(2000, Math.round(rest * 0.03)));
  return Math.ceil(Math.max(due, min) / 100) * 100;
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

export function gemPlan(debt: Debt, s: Settings, perPayIn?: PerPay): GemPlanResult {
  const dates = [debt.balance?.asOf, ...debt.plans.map((p) => p.asOf)].filter(Boolean) as ISODate[];
  const start = dates.sort()[dates.length - 1] ?? todayISO();
  const buckets = gemBuckets(debt, start);
  const inst = buckets.filter((b) => b.kind === 'instalment');
  const instalmentsDue = inst.reduce((t, b) => t + Math.min(b.left, b.monthly), 0);
  // Minimum uses the real card balance when plans are overstated.
  const bal = owed(debt);
  const planRest = buckets.filter((b) => b.kind !== 'instalment').reduce((t, b) => t + b.left, 0);
  const rest = Math.min(planRest, Math.max(0, bal - instalmentsDue));
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

  // Recommended for this statement (balance-scaled leftovers, so overstated plans don't inflate it).
  const recommended = gemDue(gemBucketsForRecommend(debt, start), paydays[0] ?? start, paydays, minimum);
  const amount = usualPay(perPayIn) ?? recommended;
  const more = lastOneOff(perPayIn);

  // Simulate each payday. A pay with a one-pay amount (extra from Optimise) pays that instead.
  const payments = new Map<Bucket, Payment[]>(buckets.map((b) => [b, []]));
  const warnings = new Map<Bucket, string>();
  const used = new Set<ISODate>();
  for (const date of paydays) {
    // With nothing set, each statement pays what it needs to avoid interest then: it drops as plans finish.
    const pay = payFor(perPayIn, periodContaining(date, s).start, used) ?? (date === paydays[0] ? recommended : gemDue(buckets, date, paydays));
    if (buckets.every((b) => b.left <= 0)) break;
    if (pay <= 0) { if (more && more > date) continue; break; }
    for (const b of buckets) {
      if (b.kind === 'promo' && b.left > 0 && b.end <= date && !warnings.has(b)) {
        warnings.set(b, `${fmt(b.left)} will still be owed when interest-free ends on ${b.end}, so interest is charged on it from then.`);
      }
    }
    for (const [b, x] of gemSplit(buckets, pay, date)) {
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

/**
 * Take `amount` off the plans in `ids`, in the order Gem applies a payment. No payment is recorded: it's
 * for plans that haven't caught up with the card's balance (see `payments.ts` → `fitPlansToBalance`).
 */
export function gemTakeOff(debt: Debt, ids: Set<string>, amount: Cents, date: ISODate): Cents {
  const buckets = gemBuckets(debt, date).filter((b) => !b.synthetic && ids.has(b.plan.id));
  let used = 0;
  for (const [b, x] of gemSplit(buckets, amount, date)) {
    used += x;
    b.plan.remaining = b.left;
    b.plan.asOf = later(b.plan.asOf, date);
  }
  return used;
}

/** A payment you've made to Gem, split the way Gem splits it. */
export function gemApply(debt: Debt, amount: Cents, s: Settings, date: ISODate): { applied: Applied[]; leftover: Cents } {
  // With no statement day, payments are planned for paydays: one made on a payday is that payday's own,
  // so (as for other debts) it's dated the day after and that payday isn't planned again.
  const asOf = !debt.statementDay && periodContaining(date, s).start === date ? addDays(date, 1) : date;
  const period = periodContaining(date, s);
  // What this pay was going to send before the payment (statement-day or payday schedules in the period).
  const beforeDue = debtSchedules(debt, s)
    .flatMap((sch) => sch.payments.filter((p) => p.date >= period.start && p.date <= period.end).map((p) => ({
      date: p.date, amount: p.amount, name: sch.plan.name, planId: sch.plan.id, synthetic: !!sch.synthetic,
    })));
  const buckets = gemBuckets(debt, date);
  const got = debt.statementDay && Number(date.slice(8, 10)) < debt.statementDay
    ? oldestFirst(buckets, amount)
    : gemSplit(buckets, amount, date);
  const applied: Applied[] = [];
  let used = 0;
  for (const [b, x] of got) {
    used += x;
    applied.push({ planId: b.plan.id, planName: b.plan.name, date, amount: x, cleared: b.left === 0 });
    if (!b.synthetic) { b.plan.remaining = b.left; b.plan.asOf = later(b.plan.asOf, asOf); }
  }
  if (debt.balance) debt.balance = { amount: Math.max(0, debt.balance.amount - amount), asOf: later(debt.balance.asOf, asOf) };
  debt.plans = debt.plans.filter((p) => p.remaining > 0);
  // Early Gem payments still leave a statement-day schedule; only keep `paid` when that schedule for
  // this pay is gone (cleared / paid off), so the Planner card doesn’t drop to $0 or double-count.
  const stillDue = debtSchedules(debt, s)
    .flatMap((sch) => sch.payments.filter((p) => p.date >= period.start && p.date <= period.end));
  if (!stillDue.length && beforeDue.length) {
    rememberPaid(debt, beforeDue.map((x) => (x.synthetic
      ? { date: x.date, amount: x.amount, name: x.name, synthetic: true as const }
      : { date: x.date, amount: x.amount, name: x.name, planId: x.planId })));
  }
  recordPaymentHistory(debt, date, amount);
  return { applied, leftover: amount - used };
}

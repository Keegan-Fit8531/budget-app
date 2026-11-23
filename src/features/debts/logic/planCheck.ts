import { addDays, diffDays, fmtShort, type ISODate } from '../../../core/dates';
import { cash } from '../../../core/money';
import type { Budget, Cents, Debt, DebtPlan } from '../../../core/types';
import { tidy } from './cardPlans';
import { gemPlanEnds, gemPlanType } from './gem';
import { monthsUntil } from './activity';

// ---------------------------------------------------------------------------------------------
// Plan check: big Gem purchases the bank can't say the plan of. A $250+ purchase Gem moves onto a 6-month
// plan shows a plan transfer (`cardPlans.ts`); one without (a special deal of 12–60 months, or an older
// 6-month one) is asked about once: how long its plan is, and what's left on it. Each answer sets up (or
// corrects) its plan, and can be undone.
// ---------------------------------------------------------------------------------------------

/** Gem puts purchases of this much or more on a plan. */
export const PLAN_MIN: Cents = 25000;
/** Purchases older than this aren't asked about: any plan on them has finished. */
const LOOK_BACK_DAYS = 2 * 365;
/** Gem moves a purchase onto a 6-month plan within a few days: don't ask before then. */
const POSTED_WAIT = 4, PENDING_WAIT = 2;

export interface PlanQuestion {
  key: string; debtId: string; debtName: string;
  date: ISODate; amount: Cents; name: string; pending: boolean;
  /** The plan already here for it, if any (e.g. set up from a screenshot). */
  plan?: DebtPlan;
}

const keyOf = (date: ISODate, amount: Cents) => `${date}|${amount}`;
const TRANSFER = /plan transfer/i;

/** The plan here that's for a purchase: the same amount, bought within a few days. */
const planFor = (debt: Debt, date: ISODate, amount: Cents) =>
  debt.plans.find((p) => p.original === amount && Math.abs(diffDays(p.purchaseDate, date)) <= 5);

/** Big Gem purchases with no plan transfer that aren't answered and aren't already a special deal here. */
export function planQuestions(b: Budget, today: ISODate): PlanQuestion[] {
  const out: PlanQuestion[] = [];
  for (const debt of b.debts ?? []) {
    if (debt.rules !== 'gem') continue;
    const txns = debt.transactions ?? [];
    const moved = (t: { date: ISODate; amount: Cents }) => txns.some((x) => /plan transfer in/i.test(x.description) && x.amount === t.amount && x.date >= t.date && x.date <= addDays(t.date, 30));
    const candidates = [
      ...txns.filter((t) => diffDays(t.date, today) >= POSTED_WAIT).map((t) => ({ ...t, pending: false })),
      ...(debt.pending ?? []).filter((t) => diffDays(t.date, today) >= PENDING_WAIT).map((t) => ({ ...t, pending: true })),
    ];
    for (const t of candidates) {
      const amount = -t.amount;
      if (amount < PLAN_MIN || TRANSFER.test(t.description) || t.date < addDays(today, -LOOK_BACK_DAYS) || moved(t)) continue;
      const key = keyOf(t.date, amount);
      if (debt.planAnswers?.[key]) continue;
      const plan = planFor(debt, t.date, amount);
      // Already set up as a special deal (12 months or more): nothing to ask.
      if (plan && (plan.months ?? 0) > 6) continue;
      out.push({ key, debtId: debt.id, debtName: debt.name, date: t.date, amount, name: tidy(t.description), pending: t.pending, ...(plan ? { plan } : {}) });
    }
  }
  return out.sort((x, y) => y.date.localeCompare(x.date));
}

/** What's likely left on a plan of `months` bought on `date`: all of it for 6 months or a recent purchase, else the months still to go. */
export function estimateLeft(q: Pick<PlanQuestion, 'date' | 'amount' | 'pending'>, months: number, today: ISODate): Cents {
  if (months <= 0) return 0;
  const ends = gemPlanEnds(q.date, months);
  if (ends <= today) return 0;
  if (months <= 6 || q.pending || diffDays(q.date, today) < 31) return q.amount;
  return Math.round((q.amount * Math.min(months, monthsUntil(today, ends))) / months);
}

/**
 * Save an answer: the purchase's plan becomes `months` long (Gem: 6 interest-free, 12+ equal payments)
 * with `left` still to pay, or (0) it has no plan here. The plan as it was is kept for Undo.
 */
export function answerPlan(b: Budget, q: PlanQuestion, months: number, left: Cents, today: ISODate): void {
  const debt = (b.debts ?? []).find((d) => d.id === q.debtId);
  if (!debt) return;
  const plan = planFor(debt, q.date, q.amount);
  debt.planAnswers = { ...(debt.planAnswers ?? {}), [q.key]: { months, was: plan ? structuredClone(plan) : null, on: today } };
  if (months <= 0 || left <= 0) { if (plan) debt.plans = debt.plans.filter((p) => p !== plan); return; }
  const set = { type: gemPlanType(months), months, ends: gemPlanEnds(q.date, months), remaining: Math.min(left, q.amount), asOf: today };
  if (plan) Object.assign(plan, set);
  else debt.plans.push({ id: `ask-${q.date}-${q.amount}`, name: q.name, original: q.amount, purchaseDate: q.date, ...set });
}

export interface PlanAnswer { key: string; debtId: string; title: string }

/** Answers that can be undone, newest first. */
export function planAnswers(b: Budget): PlanAnswer[] {
  return (b.debts ?? []).flatMap((d) => Object.entries(d.planAnswers ?? {}).map(([key, a]) => {
    const [date, amount] = key.split('|');
    const what = a.months ? `${a.months}-month plan` : 'not on a plan';
    return { key, debtId: d.id, on: a.on, title: `${cash(Number(amount))} on ${fmtShort(date)} ${date.slice(0, 4)}: ${what}` };
  })).sort((x, y) => y.on.localeCompare(x.on)).map(({ key, debtId, title }) => ({ key, debtId, title }));
}

/** Undo an answer: the plan goes back to how it was (or goes, if the answer made it), and it's asked again. */
export function undoPlanAnswer(b: Budget, debtId: string, key: string): void {
  const debt = (b.debts ?? []).find((d) => d.id === debtId);
  const a = debt?.planAnswers?.[key];
  if (!debt || !a) return;
  const [date, amount] = key.split('|');
  const now = planFor(debt, date, Number(amount));
  debt.plans = debt.plans.filter((p) => p !== now);
  if (a.was) debt.plans.push(structuredClone(a.was));
  debt.planAnswers = Object.fromEntries(Object.entries(debt.planAnswers ?? {}).filter(([k]) => k !== key));
}

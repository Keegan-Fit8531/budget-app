import { addDays, addMonths, diffDays, fmtShort, gemCycleEndOnOrAfter, type ISODate } from '../../../core/dates';
import type { Cents, Debt, DebtPlan } from '../../../core/types';
import { cleanDescription } from '../../insights/logic/spending';
import { gemPlanEnds } from './gem';

// ---------------------------------------------------------------------------------------------
// Plans read from a card's own transactions (Gem Visa through the bank connection). Gem moves a
// purchase of $250 or more onto a 6-month interest-free plan a few days after it posts, and shows that as
// a pair on the same day: "PLAN TRANSFER OUT" (+$x) and "PLAN TRANSFER IN" (−$x). Every such purchase in a statement month (21st to 20th) goes on the same plan,
// all ending the same day: the bank shows only the purchases, so the plan is put together here. What's
// left on it follows the card's balance (`payments.ts` → `fitPlansToBalance`); a statement or "My plans"
// screenshot sets it exactly. A special deal (36 or 60 months, bought in store) posts without a
// plan transfer, so the bank can't say what it is: those plans are yours to set, and are left alone here.
// ---------------------------------------------------------------------------------------------

const GEM_PLAN_MONTHS = 6;
const TRANSFER = /plan transfer/i;

export interface CardPlanPurchase { name: string; date: ISODate; amount: Cents }

/** The purchases a card's transactions show going onto a 6-month plan. */
export function cardPlanPurchases(debt: Debt): CardPlanPurchase[] {
  const txns = debt.transactions ?? [];
  const used = new Set<number>();
  const out: CardPlanPurchase[] = [];
  for (const t of txns) {
    if (t.amount >= 0 || !/plan transfer in/i.test(t.description)) continue;
    // The purchase it moved: the latest of that amount in the month before, not a transfer itself.
    let at = -1;
    for (let i = txns.length - 1; i >= 0; i--) {
      const x = txns[i];
      if (used.has(i) || x.amount !== t.amount || TRANSFER.test(x.description) || x.date > t.date || x.date < addDays(t.date, -30)) continue;
      at = i; break;
    }
    if (at < 0) continue;
    used.add(at);
    out.push({ name: tidy(txns[at].description), date: txns[at].date, amount: -t.amount });
  }
  return out;
}

/** "TAILOR SHOP AUCKLAND NZ" → "Tailor Shop Auckland NZ" (short capitals stay as they are). */
const tidy = (d: string) => {
  const name = cleanDescription(d);
  return name !== name.toUpperCase() ? name : name.split(' ').map((w) => (w.length <= 3 ? w : w[0] + w.slice(1).toLowerCase())).join(' ');
};

/** A 6-month plan made here from the card's plan transfers (`card-` ids): one per statement month. Plans you or a statement set are never merged or grown. */
const isCyclePlan = (p: DebtPlan) => p.id.startsWith('card-') && p.type === 'interest-free' && !!p.ends;

/** "Purchases 21 Oct – 20 Nov 2026": the statement month (21st to 20th) a purchase made on `date` is in. */
export function cycleName(date: ISODate): string {
  const end = gemCycleEndOnOrAfter(date);
  return `Purchases ${fmtShort(addDays(addMonths(end, -1), 1))} – ${fmtShort(end)} ${end.slice(0, 4)}`;
}

/**
 * Gem puts every purchase of $250 or more in a statement month (21st to 20th) on one 6-month plan, all
 * ending the same day. Plans here that end the same day (one per purchase, from older syncs) become that
 * one plan; payments counted against the others are moved to it.
 */
export function mergeCyclePlans(debt: Debt): void {
  const byEnd = new Map<ISODate, DebtPlan[]>();
  for (const p of debt.plans.filter(isCyclePlan)) byEnd.set(p.ends!, [...(byEnd.get(p.ends!) ?? []), p]);
  for (const group of byEnd.values()) {
    if (group.length < 2) continue;
    const [keep, ...rest] = [...group].sort((a, b) => a.purchaseDate.localeCompare(b.purchaseDate));
    const sum = (f: (p: DebtPlan) => Cents) => group.reduce((t, p) => t + f(p), 0);
    Object.assign(keep, {
      name: cycleName(keep.purchaseDate), original: sum((p) => p.original), remaining: sum((p) => p.remaining),
      asOf: group.map((p) => p.asOf).sort().pop()!,
    });
    const gone = new Set(rest.map((p) => p.id));
    for (const x of debt.paid ?? []) if (x.planId && gone.has(x.planId)) { x.planId = keep.id; x.name = keep.name; }
    for (const bp of debt.bankPayments ?? []) if (bp.planned) bp.planned = bp.planned.map((k) => { const [d, a, id] = k.split('|'); return gone.has(id) ? `${d}|${a}|${keep.id}` : k; });
    debt.plans = debt.plans.filter((p) => !gone.has(p.id));
  }
}

/**
 * Keep a Gem card's 6-month plans in line with its plan transfers: one plan per statement month, at least
 * as much as the purchases moved onto it. A statement month's plan is made once (a paid-off one isn't made
 * again), and grows when another purchase joins it. Returns the plans made or grown (their amounts are
 * the card's purchases, not a statement's).
 */
export function syncCardPlans(debt: Debt, today: ISODate): DebtPlan[] {
  if (debt.rules !== 'gem') return [];
  mergeCyclePlans(debt);
  const made = new Set((debt.cardPlans ?? []).filter((k) => !k.includes('|')));
  const cycles = new Map<ISODate, { first: ISODate; total: Cents }>();
  for (const f of cardPlanPurchases(debt)) {
    const ends = gemPlanEnds(f.date, GEM_PLAN_MONTHS);
    if (ends <= today) continue;
    const c = cycles.get(ends) ?? { first: f.date, total: 0 };
    c.first = f.date < c.first ? f.date : c.first;
    c.total += f.amount;
    cycles.set(ends, c);
  }
  const changed: DebtPlan[] = [];
  for (const [ends, c] of cycles) {
    let plan = debt.plans.find((p) => isCyclePlan(p) && p.ends === ends);
    if (!plan) {
      if (made.has(ends)) continue;
      plan = { id: `card-${ends}`, name: cycleName(c.first), type: 'interest-free', months: GEM_PLAN_MONTHS, original: 0, remaining: 0, asOf: today, purchaseDate: c.first, ends };
      debt.plans.push(plan);
    }
    made.add(ends);
    const grow = c.total - plan.original;
    if (grow > 0) {
      Object.assign(plan, { original: c.total, remaining: plan.remaining + grow, asOf: today, name: cycleName(c.first) });
      if (c.first < plan.purchaseDate) plan.purchaseDate = c.first;
      changed.push(plan);
    }
  }
  // A plan for a purchase still pending (a special deal you set up from a screenshot) has had nothing paid off it yet.
  for (const t of debt.pending ?? []) {
    const plan = debt.plans.find((p) => p.original === -t.amount && Math.abs(diffDays(p.purchaseDate, t.date)) <= 5);
    if (plan && plan.remaining < plan.original) { plan.remaining = plan.original; plan.asOf = today; }
  }
  debt.cardPlans = [...made].sort().slice(-60);
  return changed;
}

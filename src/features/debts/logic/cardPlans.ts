import { addDays, diffDays, type ISODate } from '../../../core/dates';
import type { Cents, Debt, DebtPlan } from '../../../core/types';
import { cleanDescription } from '../../insights/logic/spending';
import { gemPlanEnds } from './gem';

// ---------------------------------------------------------------------------------------------
// Plans read from a card's own transactions (Gem Visa through the bank connection). Gem moves a
// purchase of $250 or more onto a 6-month interest-free plan a few days after it posts, and shows that as
// a pair on the same day: "PLAN TRANSFER OUT" (+$x) and "PLAN TRANSFER IN" (−$x). A purchase that big still
// pending will become one. Each becomes a plan here once; what's left on it then follows the card's balance
// (`payments.ts` → `fitPlansToBalance`), and a statement or "My plans" screenshot sets it exactly.
// ---------------------------------------------------------------------------------------------

/** Gem puts purchases of this much or more on a 6-month interest-free plan. */
export const GEM_PLAN_MIN: Cents = 25000;
const GEM_PLAN_MONTHS = 6;
const TRANSFER = /plan transfer/i;

export interface CardPlanPurchase { name: string; date: ISODate; amount: Cents; pending: boolean }

/** The purchases a card's transactions show going onto a plan, and big ones still pending (which will). */
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
    out.push({ name: tidy(txns[at].description), date: txns[at].date, amount: -t.amount, pending: false });
  }
  for (const p of debt.pending ?? []) {
    if (p.amount <= -GEM_PLAN_MIN && !TRANSFER.test(p.description)) out.push({ name: tidy(p.description), date: p.date, amount: -p.amount, pending: true });
  }
  return out;
}

/** "REMBRANDT SUITS AUCKLAND NZ" → "Rembrandt Suits Auckland NZ" (short capitals stay as they are). */
const tidy = (d: string) => {
  const name = cleanDescription(d);
  return name !== name.toUpperCase() ? name : name.split(' ').map((w) => (w.length <= 3 ? w : w[0] + w.slice(1).toLowerCase())).join(' ');
};

const keyOf = (x: { date: ISODate; amount: Cents }) => `${x.date}|${x.amount}`;

/**
 * Add the plans a Gem card's transactions show that aren't plans here yet (still interest-free), each
 * once. A plan for a purchase that's still pending is put back to its full amount: nothing can have
 * been paid off it yet. Returns the plans added.
 */
export function syncCardPlans(debt: Debt, today: ISODate): DebtPlan[] {
  if (debt.rules !== 'gem') return [];
  const seen = new Set(debt.cardPlans ?? []);
  const added: DebtPlan[] = [];
  for (const f of cardPlanPurchases(debt)) {
    const match = debt.plans.find((p) => p.original === f.amount && Math.abs(diffDays(p.purchaseDate, f.date)) <= 5);
    if (match) {
      if (f.pending && match.remaining < match.original) { match.remaining = match.original; match.asOf = today; }
      seen.add(keyOf(f));
      continue;
    }
    const ends = gemPlanEnds(f.date, GEM_PLAN_MONTHS);
    if (seen.has(keyOf(f)) || ends <= today) continue;
    const plan: DebtPlan = { id: `card-${keyOf(f).replace('|', '-')}`, name: f.name || `Purchase on ${f.date}`, type: 'interest-free', months: GEM_PLAN_MONTHS, original: f.amount, remaining: f.amount, asOf: today, purchaseDate: f.date, ends };
    debt.plans.push(plan);
    added.push(plan);
    seen.add(keyOf(f));
  }
  if (seen.size) debt.cardPlans = [...seen].sort().slice(-200);
  return added;
}

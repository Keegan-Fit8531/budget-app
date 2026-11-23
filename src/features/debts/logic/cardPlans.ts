import { addDays, addMonths, diffDays, gemCycleEndOnOrAfter, monthName, type ISODate } from '../../../core/dates';
import type { Cents, Debt, DebtPlan } from '../../../core/types';
import { cleanDescription } from '../../insights/logic/spending';
import { gemPlanEnds } from './gem';
import { fitPlansToBalance } from './payments';

// ---------------------------------------------------------------------------------------------
// Plans read from a card's own transactions (Gem Visa through the bank connection). Gem moves a
// purchase of $250 or more onto a 6-month interest-free plan a few days after it posts, and shows that as
// a pair on the same day: "PLAN TRANSFER OUT" (+$x) and "PLAN TRANSFER IN" (−$x). Every purchase moved in a statement month (21st to 20th), by the transfer's date, not the purchase's, goes on the same plan,
// all ending the same day: the bank shows only the purchases, so the plan is put together here. What's
// left on it follows the card's balance (`payments.ts` → `fitPlansToBalance`); a statement or "My plans"
// screenshot sets it exactly. A special deal (36 or 60 months, bought in store) posts without a
// plan transfer, so the bank can't say what it is: those plans are yours to set, and are left alone here.
// ---------------------------------------------------------------------------------------------

const GEM_PLAN_MONTHS = 6;
const TRANSFER = /plan transfer/i;

/** A purchase moved onto a plan: bought on `date`, moved on `moved` (which decides the plan it joins). */
export interface CardPlanPurchase { name: string; date: ISODate; moved: ISODate; amount: Cents }

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
    out.push({ name: tidy(txns[at].description), date: txns[at].date, moved: t.date, amount: -t.amount });
  }
  return out;
}

/** "TAILOR SHOP AUCKLAND NZ" → "Tailor Shop Auckland NZ" (short capitals stay as they are). */
export const tidy = (d: string) => {
  const name = cleanDescription(d);
  return name !== name.toUpperCase() ? name : name.split(' ').map((w) => (/^[^AEIOU]{2,3}$|^(AKL|ATM)$/.test(w) ? w : w[0] + w.slice(1).toLowerCase())).join(' ');
};

/** A 6-month plan made here from the card's plan transfers (`card-` ids): one per statement month. Its amount is the card's purchases; plans you or a statement set are never merged or changed. */
const isCyclePlan = (p: DebtPlan) => p.id.startsWith('card-') && p.type === 'interest-free' && !!p.ends;

/** A statement month's plan as Gem names it, read from a "My plans" screenshot ("Purchases from Oct 2026 - Nov 2026"). */
const isGemMonthPlan = (p: DebtPlan) => p.type === 'interest-free' && !!p.ends && /^purchases\b/i.test(p.name);

/** "Purchases from Oct 2026 – Nov 2026", as Gem names it: the statement month (21st to 20th) a purchase moved onto a plan on `date` joins. */
export function cycleName(date: ISODate): string {
  const end = gemCycleEndOnOrAfter(date);
  const month = (d: ISODate) => `${monthName(d).slice(0, 3)} ${d.slice(0, 4)}`;
  return `Purchases from ${month(addMonths(end, -1))} – ${month(end)}`;
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
 * Plans for purchases the card still shows as pending (a special deal set up from a screenshot): nothing can
 * have been paid off them yet, so each is put back to its full amount. Returns their ids.
 */
export function pendingPlans(debt: Debt, today: ISODate): Set<string> {
  const ids = new Set<string>();
  for (const t of debt.pending ?? []) {
    const plan = debt.plans.find((p) => p.original === -t.amount && Math.abs(diffDays(p.purchaseDate, t.date)) <= 5);
    if (!plan) continue;
    ids.add(plan.id);
    if (plan.remaining < plan.original) { plan.remaining = plan.original; plan.asOf = today; }
  }
  return ids;
}

/**
 * Keep a Gem card's 6-month plans in line with its plan transfers: one plan per statement month, holding
 * exactly the purchases moved onto it in that month. A month's plan is made once (a paid-off one isn't
 * made again). One you set from a screenshot ("Purchases from …") is used instead, and only grows when a
 * purchase joins it. Returns our plans (`guessed`: what's left on them is a guess) and plans for purchases
 * still pending (`pending`: nothing can have been paid off them).
 */
export function syncCardPlans(debt: Debt, today: ISODate): { guessed: Set<string>; pending: Set<string> } {
  const none = { guessed: new Set<string>(), pending: new Set<string>() };
  if (debt.rules !== 'gem') return none;
  mergeCyclePlans(debt);
  const made = new Set((debt.cardPlans ?? []).filter((k) => !k.includes('|')));
  const cycles = new Map<ISODate, { first: ISODate; moved: ISODate; total: Cents }>();
  for (const f of cardPlanPurchases(debt)) {
    // Gem puts it on the plan for the statement month it was moved in, not the one it was bought in.
    const ends = gemPlanEnds(f.moved, GEM_PLAN_MONTHS);
    if (ends <= today) continue;
    const c = cycles.get(ends) ?? { first: f.date, moved: f.moved, total: 0 };
    if (f.date < c.first) c.first = f.date;
    c.total += f.amount;
    cycles.set(ends, c);
  }
  // A plan of ours whose month has no purchases now (it was put in the wrong month before) goes.
  for (const p of debt.plans.filter((x) => isCyclePlan(x) && x.ends! > today && !cycles.has(x.ends!))) {
    debt.plans = debt.plans.filter((x) => x !== p);
  }
  for (const [ends, c] of cycles) {
    const ours = debt.plans.find((p) => isCyclePlan(p) && p.ends === ends);
    const theirs = ours ? undefined : debt.plans.find((p) => isGemMonthPlan(p) && p.ends === ends);
    if (theirs) {
      // Set from a screenshot or statement: only a purchase that's joined it since adds to it.
      made.add(ends);
      const grow = c.total - theirs.original;
      if (grow > 0) Object.assign(theirs, { original: c.total, remaining: theirs.remaining + grow, asOf: today });
      continue;
    }
    if (!ours && made.has(ends)) continue;
    const plan: DebtPlan = ours ?? { id: `card-${ends}`, name: '', type: 'interest-free', months: GEM_PLAN_MONTHS, original: 0, remaining: 0, asOf: today, purchaseDate: c.first, ends };
    if (!ours) debt.plans.push(plan);
    made.add(ends);
    // Ours is the card's purchases in that month, exactly.
    Object.assign(plan, { name: cycleName(c.moved), purchaseDate: c.first, original: c.total });
  }
  debt.cardPlans = [...made].sort().slice(-60);
  return resetGuesses(debt, today);
}

/** A plan whose amount left is worked out here, not given: our 6-month plans (`card-`), and plans from Plan check answers (`ask-`). */
export const isGuess = (p: DebtPlan): boolean => p.id.startsWith('card-') || p.id.startsWith('ask-');

/**
 * Every plan whose amount left is worked out here goes back to its full amount (ended ones go), ready to
 * be fitted to the card's balance again: what's left on each is then the same every time, worked out
 * from the balance in Gem's order, never a figure brought down a little more on each sync. Returns those
 * plans, and the plans for purchases still pending.
 */
function resetGuesses(debt: Debt, today: ISODate): { guessed: Set<string>; pending: Set<string> } {
  // A plan for a purchase still pending (a special deal) has had nothing paid off it yet.
  const pending = pendingPlans(debt, today);
  debt.plans = debt.plans.filter((p) => !isGuess(p) || !p.ends || p.ends > today);
  for (const p of debt.plans) if (isGuess(p) && p.remaining !== p.original) { p.remaining = p.original; p.asOf = today; }
  return { guessed: new Set(debt.plans.filter(isGuess).map((p) => p.id)), pending };
}

/**
 * Work out what's left on each plan from the card's balance: plans worked out here start full, and what
 * all the plans add up to over the balance comes off them in Gem's order (instalments due, then the
 * interest-free plans that end soonest), before plans you or a statement set, and never off a pending
 * purchase's plan. Used after a Plan check answer; a bank sync does the same through `applyStatement`.
 */
export function refitPlans(debt: Debt, today: ISODate): void {
  if (debt.rules !== 'gem') return;
  const { guessed, pending } = resetGuesses(debt, today);
  fitPlansToBalance(debt, today, debt.plans.filter((p) => !guessed.has(p.id) && !pending.has(p.id)).map((p) => p.id), pending);
}

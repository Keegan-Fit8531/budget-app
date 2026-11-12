import type { ISODate } from './dates';
import { budgetPeriod, planFor, shiftPeriod } from './engine';
import type { Budget, Cents, GoalCost, SavingsGoal } from './types';

export const DEFAULT_COST_CATEGORIES = ['Venue and hire', 'Suppliers', 'Food and drink', 'Attire'];

/** The earlier, narrower categories and the broad group each now belongs to. */
const OLD_TO_GROUP: Record<string, string> = {
  'Venue': 'Venue and hire', 'Hire': 'Venue and hire', 'Flowers and decor': 'Venue and hire', 'Decor': 'Venue and hire',
  'Photos and video': 'Suppliers', 'Music': 'Suppliers', 'Celebrant': 'Suppliers',
  'Rings': 'Attire',
};

/**
 * Tidy costs into a few broad groups (Venue and hire, Suppliers, Food and drink, Attire).
 * Categories you made yourself that don't map are kept.
 */
export function groupCostCategories(b: Budget): void {
  for (const g of b.savings ?? []) for (const c of g.costs ?? []) if (c.category && OLD_TO_GROUP[c.category]) c.category = OLD_TO_GROUP[c.category];
  const used = new Set((b.savings ?? []).flatMap((g) => (g.costs ?? []).map((c) => c.category).filter(Boolean) as string[]));
  const custom = (b.costCategories ?? []).filter((c) => !OLD_TO_GROUP[c] && !DEFAULT_COST_CATEGORIES.includes(c) && !['Honeymoon', 'Other'].includes(c));
  const leftovers = [...used].filter((c) => !DEFAULT_COST_CATEGORIES.includes(c) && !custom.includes(c));
  b.costCategories = [...DEFAULT_COST_CATEGORIES, ...custom, ...leftovers];
}

/** Spent on a cost so far. */
export function spentOn(c: GoalCost): Cents {
  return (c.spends ?? []).reduce((t, x) => t + x.amount, 0);
}

/** Still to pay on a cost: nothing if it's marked paid, else its amount minus what's been spent. */
export function leftOn(c: GoalCost): Cents {
  return c.paid ? 0 : Math.max(0, c.amount - spentOn(c));
}

export interface CostCheck {
  cost: GoalCost;
  /** Date it's checked against: its due date, or the goal's target date. */
  by?: ISODate;
  /** Projected fund on that date, after earlier costs come out. */
  available: Cents;
  covered: boolean;
  /** How much of this cost the fund can't cover (at most the cost itself). */
  short: Cents;
}

export interface GoalCostSummary {
  total: Cents;
  paid: Cents;
  toPay: Cents;
  /** Projected saved by the target date (before paying the remaining costs). */
  byTarget?: Cents;
  /** byTarget − toPay. */
  leftAtTarget?: Cents;
  checks: CostCheck[];
  /** Steady amount each pay that covers every cost by its date. */
  neededPerPay?: Cents;
  byCategory: { category: string; amount: Cents }[];
}

/** Projected fund at the end of `date`: today's balance plus each pay's contribution up to then. */
export function projectedAt(b: Budget, goal: SavingsGoal, date: ISODate, today: ISODate): { amount: Cents; pays: number } {
  // Expected gifts (not yet in the balance) count from their date.
  let amount = goal.balance + expectedGifts(goal, date);
  let pays = 0;
  let p = budgetPeriod(b, today);
  for (let i = 0; i < 400 && p.start <= date; i++) {
    const funded = planFor(b, p).accounts.find((a) => a.account.id === goal.accountId)?.funded ?? 0;
    amount += funded + (goal.otherPerPay ?? 0);
    pays++;
    p = shiftPeriod(p, 1, b.settings);
  }
  return { amount, pays };
}

/** Money expected (not yet received) for a goal on or before `date`. */
export function expectedGifts(goal: SavingsGoal, date: ISODate): Cents {
  return (goal.gifts ?? []).filter((x) => !x.received && x.date <= date).reduce((t, x) => t + x.amount, 0);
}

export function summariseCosts(b: Budget, goal: SavingsGoal, today: ISODate): GoalCostSummary {
  const costs = goal.costs ?? [];
  const total = costs.reduce((t, c) => t + Math.max(c.amount, spentOn(c)), 0);
  const toPay = costs.reduce((t, c) => t + leftOn(c), 0);
  const paid = total - toPay;
  const unpaid = costs.filter((c) => leftOn(c) > 0)
    .map((c) => ({ c, by: c.due ?? goal.targetDate, left: leftOn(c) }))
    .sort((x, y) => (x.by ?? '9999').localeCompare(y.by ?? '9999'));

  let spent = 0;
  const checks: CostCheck[] = unpaid.map(({ c, by, left }) => {
    const at = by ? projectedAt(b, goal, by, today).amount : goal.balance;
    spent += left;
    const available = at - (spent - left);
    return { cost: c, by, available, covered: at >= spent, short: Math.min(left, Math.max(0, spent - at)) }; // this cost's own uncovered part
  });

  // Steady per-pay amount so every cost is covered by its date.
  let neededPerPay: Cents | undefined;
  let cum = 0;
  for (const { by, left } of unpaid) {
    cum += left;
    if (!by) continue;
    const pays = projectedAt(b, goal, by, today).pays;
    const need = cum - goal.balance - expectedGifts(goal, by) - (goal.otherPerPay ?? 0) * pays;
    const per = pays > 0 ? Math.ceil(need / pays) : need;
    neededPerPay = Math.max(neededPerPay ?? 0, per, 0);
  }

  const byTarget = goal.targetDate ? projectedAt(b, goal, goal.targetDate, today).amount : undefined;
  const cats = new Map<string, Cents>();
  for (const c of costs) cats.set(c.category || 'Other', (cats.get(c.category || 'Other') ?? 0) + Math.max(c.amount, spentOn(c)));
  return {
    total, paid, toPay, checks, neededPerPay,
    byTarget, leftAtTarget: byTarget !== undefined ? byTarget - toPay : undefined,
    byCategory: [...cats.entries()].map(([category, amount]) => ({ category, amount })).sort((x, y) => y.amount - x.amount),
  };
}

/** Spend money from a goal on a cost (existing, or a new one). Takes it off the saved balance. */
export function spendFromGoal(goal: SavingsGoal, spend: { id: string; amount: Cents; date: ISODate; note?: string },
  target: { costId: string } | { newCost: { id: string; name: string; category: string } }): void {
  goal.costs = goal.costs ?? [];
  let cost = 'costId' in target ? goal.costs.find((c) => c.id === target.costId) : undefined;
  if (!cost && 'newCost' in target) {
    // Something not budgeted for: add it as a cost of exactly what was spent.
    cost = { ...target.newCost, amount: spend.amount };
    goal.costs.push(cost);
  }
  if (!cost) return;
  cost.spends = [...(cost.spends ?? []), spend];
  goal.balance = Math.max(0, goal.balance - spend.amount);
  goal.asOf = spend.date > goal.asOf ? spend.date : goal.asOf;
}

/** Undo a spend: puts the money back in the fund. */
export function removeSpend(goal: SavingsGoal, costId: string, spendId: string): void {
  const cost = goal.costs?.find((c) => c.id === costId);
  const s = cost?.spends?.find((x) => x.id === spendId);
  if (!cost || !s) return;
  cost.spends = cost.spends!.filter((x) => x.id !== spendId);
  goal.balance += s.amount;
}

/** Your cost categories, plus any still used by a cost but no longer in the list. */
export function costCategories(b: Budget): string[] {
  const list = b.costCategories?.length ? [...b.costCategories] : [...DEFAULT_COST_CATEGORIES];
  for (const g of b.savings ?? []) for (const c of g.costs ?? []) if (c.category && !list.includes(c.category)) list.push(c.category);
  return list;
}

/** Rename a category everywhere it's used. */
export function renameCostCategory(b: Budget, from: string, to: string): void {
  b.costCategories = costCategories(b).map((c) => (c === from ? to : c)).filter((c, i, a) => a.indexOf(c) === i);
  for (const g of b.savings ?? []) for (const c of g.costs ?? []) if (c.category === from) c.category = to;
}

/** Remove a category; its costs move to `moveTo`. */
export function removeCostCategory(b: Budget, name: string, moveTo: string): void {
  b.costCategories = costCategories(b).filter((c) => c !== name);
  if (!b.costCategories.includes(moveTo)) b.costCategories.push(moveTo);
  for (const g of b.savings ?? []) for (const c of g.costs ?? []) if (c.category === name) c.category = moveTo;
}

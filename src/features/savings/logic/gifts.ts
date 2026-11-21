// ---------------------------------------------------------------------------------------------
// Money in and out of a savings goal, and who it was from: saving an entry (received money moves the
// saved balance), people's labels and colours, and the slices of the goal's saved pie.
// ---------------------------------------------------------------------------------------------
import { colorAt } from '../../../core/colors';
import { addPerson, contributions, ME, peopleOf, UNASSIGNED } from './contributions';
import { todayISO } from '../../../core/dates';
import type { Budget, GoalGift, SavingsGoal } from '../../../core/types';

export const NEW_PERSON = '__new';
export const NEW = NEW_PERSON;
export const signed = (x?: GoalGift) => (!x || !x.received ? 0 : x.out ? -x.amount : x.amount);

/** Add or change money in/out; received money goes straight into (or out of) the saved balance. */
export function saveGift(b: Budget, goalId: string, next: GoalGift, previous?: GoalGift) {
  const g = (b.savings ?? []).find((x) => x.id === goalId);
  if (!g) return;
  const diff = signed(next) - signed(previous);
  if (diff) { g.balance = Math.max(0, g.balance + diff); g.asOf = todayISO(); }
  if (next.person && next.person !== UNASSIGNED) addPerson(g, next.person);
  g.gifts = g.gifts ?? [];
  const i = g.gifts.findIndex((x) => x.id === next.id);
  if (i >= 0) g.gifts[i] = next; else g.gifts.push(next);
}

export const personLabel = (p: string) => (p === ME ? 'Me' : p);

/** True when a goal tracks who puts money in (more than just you). */
export function tracksPeople(budget: Budget, goal: SavingsGoal): boolean {
  // Once a goal has a people list (e.g. the wedding), keep showing it, even if it's down to just you.
  return (goal.people?.length ?? 0) > 0 || contributions(budget, goal).some((p) => p.person !== ME && p.total !== 0);
}

export const colorFor = (goal: SavingsGoal, p: string) => (p === UNASSIGNED ? 'var(--muted)' : colorAt(Math.max(0, peopleOf(goal).indexOf(p))));

/** Slices for the goal's saved pie: each person's share of what's saved, anything not assigned, then what's still to go. */
export function savedSlices(budget: Budget, goal: SavingsGoal, target = goal.target) {
  const people = contributions(budget, goal).filter((p) => p.person !== UNASSIGNED);
  const named = people.reduce((t, p) => t + Math.max(0, p.total), 0);
  const unassigned = Math.max(0, goal.balance - named);
  // Costs people paid themselves count towards the goal too (they're money that didn't have to be saved).
  const direct = people.reduce((t, p) => t + p.direct, 0);
  const covered = Math.max(goal.balance, named) + direct;
  return [
    ...people.filter((p) => Math.max(0, p.total) + p.direct > 0).map((p) => ({ label: personLabel(p.person), value: Math.max(0, p.total) + p.direct, color: colorFor(goal, p.person) })),
    ...(unassigned > 0 ? [{ label: 'Not assigned', value: unassigned, color: colorFor(goal, UNASSIGNED) }] : []),
    ...(target && target > covered ? [{ label: 'To go', value: target - covered, color: 'var(--soft)' }] : []),
  ];
}

/** What the middle of the saved pie says: the balance, or everyone's total when that's bigger (costs already spent). */
export function savedCentre(budget: Budget, goal: SavingsGoal): { amount: number; label: string } {
  const named = contributions(budget, goal).filter((p) => p.person !== UNASSIGNED).reduce((t, p) => t + Math.max(0, p.total), 0);
  return named > goal.balance ? { amount: named, label: 'put in' } : { amount: goal.balance, label: 'saved' };
}

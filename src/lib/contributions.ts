import { depositFor } from './balances';
import { todayISO, type ISODate } from './dates';
import { periodContaining, shiftPeriod } from './engine';
import type { Budget, Cents, GoalCost, SavingsGoal } from './types';

export const ME = 'Me';

/** Who paid how much of a cost paid outside the fund. */
export function paidShares(c: GoalCost): { person: string; amount: Cents }[] {
  if (!c.paid || !c.paidOutside) return [];
  if (c.paidSplit?.length) return c.paidSplit;
  return c.paidBy ? [{ person: c.paidBy, amount: c.amount }] : [];
}

/** Everything paid towards the goal's costs outside the fund. */
export function paidDirect(goal: SavingsGoal): Cents {
  return (goal.costs ?? []).reduce((t, c) => t + paidShares(c).reduce((u, x) => u + x.amount, 0), 0);
}
/** Entries saved before people were tracked (no name on them yet). */
export const UNASSIGNED = 'Not assigned';

/** The people who put money into a goal: you first, then anyone named on an entry. */
export function peopleOf(goal: SavingsGoal): string[] {
  const list = goal.people?.length ? [...goal.people] : [ME];
  for (const x of goal.gifts ?? []) if (x.person && !list.includes(x.person)) list.push(x.person);
  for (const p of Object.keys(goal.personBase ?? {})) if (!list.includes(p)) list.push(p);
  for (const c of goal.costs ?? []) for (const x of paidShares(c)) if (!list.includes(x.person)) list.push(x.person);
  return list;
}

/** What your payday transfers have sent to the goal's account since the budget started (paydays up to today). */
export function fromPay(b: Budget, goal: SavingsGoal, today: ISODate = todayISO()): Cents {
  const start = b.settings.budgetStart;
  if (!start || start > today) return 0;
  // Only goals that have their account to themselves (otherwise the split can't be told apart).
  if ((b.savings ?? []).filter((g) => g.accountId === goal.accountId).length > 1) return 0;
  let p = periodContaining(start, b.settings);
  let total = 0;
  for (let i = 0; i < 60 && p.start <= today; i++) {
    if (p.start >= start) total += depositFor(b, goal.accountId, p, today);
    p = shiftPeriod(p, 1, b.settings);
  }
  return total;
}

export interface Contribution {
  person: string;
  /** Net amount put in: earlier total + from pay + added − taken out. */
  total: Cents;
  base: Cents;
  pay: Cents;
  added: Cents;
  takenOut: Cents;
  /** Promised but not arrived yet. */
  expected: Cents;
  /** Costs this person paid themselves, outside the fund (not in `total`, which is money in the fund). */
  direct: Cents;
  /** True when this total is worked out as what's left of the balance. */
  remainder?: boolean;
}

/** How much each person has put in (received money only; expected shown separately). */
export function contributions(b: Budget, goal: SavingsGoal, today: ISODate = todayISO()): Contribution[] {
  const people = peopleOf(goal);
  if ((goal.gifts ?? []).some((x) => !x.person)) people.push(UNASSIGNED);
  const pay = fromPay(b, goal, today);
  const list = people.map((person, i) => {
    const mine = (goal.gifts ?? []).filter((x) => (x.person ?? UNASSIGNED) === person);
    const added = mine.filter((x) => !x.out && x.received).reduce((t, x) => t + x.amount, 0);
    const expected = mine.filter((x) => !x.out && !x.received).reduce((t, x) => t + x.amount, 0);
    const takenOut = mine.filter((x) => x.out).reduce((t, x) => t + x.amount, 0);
    const base = goal.personBase?.[person] ?? 0;
    const p = i === 0 && person !== UNASSIGNED ? pay : 0;
    const direct = (goal.costs ?? []).reduce((t, c) => t + paidShares(c).filter((x) => x.person === person).reduce((u, x) => u + x.amount, 0), 0);
    return { person, total: base + p + added - takenOut, base, pay: p, added, takenOut, expected, direct } as Contribution;
  });
  // One person can get whatever's left of the balance once everyone else's totals are counted.
  const rest = list.find((c) => c.person === goal.remainderPerson && c.person !== UNASSIGNED);
  if (rest) {
    const others = list.filter((c) => c !== rest).reduce((t, c) => t + c.total, 0);
    Object.assign(rest, { total: goal.balance - others, base: 0, pay: 0, added: 0, takenOut: 0, remainder: true });
  }
  return list;
}

/** Set a person's total: the difference goes into their earlier amount, so their entries and pay still count. */
export function setPersonTotal(b: Budget, goal: SavingsGoal, person: string, total: Cents, today: ISODate = todayISO()): void {
  if (goal.remainderPerson === person) return; // worked out automatically
  const c = contributions(b, goal, today).find((x) => x.person === person);
  const rest = c ? c.total - c.base : 0;
  goal.personBase = { ...(goal.personBase ?? {}), [person]: total - rest };
  if (!(goal.people ?? []).includes(person)) goal.people = [...peopleOf(goal).filter((p) => p !== person), person];
}

export function addPerson(goal: SavingsGoal, name: string): void {
  const people = peopleOf(goal);
  if (!people.includes(name)) goal.people = [...people, name];
}

/** Rename someone everywhere (entries and their earlier total). */
export function renamePerson(goal: SavingsGoal, from: string, to: string): void {
  goal.people = peopleOf(goal).map((p) => (p === from ? to : p)).filter((p, i, a) => a.indexOf(p) === i);
  for (const x of goal.gifts ?? []) if (x.person === from) x.person = to;
  for (const c of goal.costs ?? []) {
    if (c.paidBy === from) c.paidBy = to;
    for (const x of c.paidSplit ?? []) if (x.person === from) x.person = to;
  }
  if (goal.personBase?.[from] !== undefined) {
    goal.personBase = { ...goal.personBase, [to]: (goal.personBase[to] ?? 0) + goal.personBase[from] };
    delete goal.personBase[from];
  }
  if (goal.remainderPerson === from) goal.remainderPerson = to;
}

/** Remove someone who has nothing recorded (their entries would be lost otherwise). */
export function removePerson(goal: SavingsGoal, name: string): boolean {
  if ((goal.gifts ?? []).some((x) => x.person === name) || (goal.costs ?? []).some((c) => paidShares(c).some((x) => x.person === name))) return false;
  goal.people = peopleOf(goal).filter((p) => p !== name);
  if (goal.personBase) delete goal.personBase[name];
  if (goal.remainderPerson === name) delete goal.remainderPerson;
  return true;
}

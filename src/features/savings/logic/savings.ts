import type { ISODate } from '../../../core/dates';
import { modeOf } from '../../../engine/balances/outflows';
import { periodContaining, shiftPeriod, type Period } from '../../../engine/periods';
import type { Budget, Cents, SavingsGoal, Settings } from '../../../core/types';

export interface GoalForecast {
  goal: SavingsGoal;
  /** Sent from pay each payday (fixed amount, or the required amount when auto). */
  perPay: Cents;
  /** Needed each pay to hit the target by the target date. */
  requiredPerPay?: Cents;
  /** Pay periods left until the target date. */
  periodsLeft?: number;
  /** When the target is reached at the current rate. */
  reachedBy?: ISODate;
  remaining?: Cents;
  /** Balance by the target date (or in 12 pays if there's no date). */
  projected: Cents;
  onTrack?: boolean;
}

/**
 * Paydays still to come after `from` and before `until` (e.g. 12 Nov → 20 Feb with pay on the 19th:
 * 19 Nov, 18 Dec, 19 Jan, 19 Feb = 4). The pay `from` falls in has already happened, so what it sent is in the balance.
 */
function countPeriods(from: ISODate, until: ISODate, s: Settings): number {
  let n = 0;
  let p = shiftPeriod(periodContaining(from, s), 1, s);
  while (p.start < until && n < 600) { n++; p = shiftPeriod(p, 1, s); }
  return n;
}

/** The day a goal's saved balance is as at (never later than today). */
export function savedAsOf(goal: Pick<SavingsGoal, 'asOf'>, today: ISODate): ISODate {
  return goal.asOf < today ? goal.asOf : today;
}

/**
 * The first pay that isn't in a goal's saved balance yet: the next payday after the day the balance was
 * last updated (the pay that day falls in has already happened, so what it sent is in the balance), and
 * never before the budget starts. Projections add each pay from this one on, so a payday that has passed
 * since the balance was updated still counts, instead of dropping out until the balance is updated.
 */
export function firstPayToCome(b: Pick<Budget, 'settings'>, goal: Pick<SavingsGoal, 'asOf'>, today: ISODate): Period {
  const from = savedAsOf(goal, today);
  return shiftPeriod(periodContaining(from, b.settings), 1, b.settings);
}

/** Per-pay amount needed by a goal (used for auto savings accounts). */
export function requiredPerPay(goal: SavingsGoal, s: Settings, from: ISODate): Cents | undefined {
  if (goal.target === undefined || !goal.targetDate) return undefined;
  const k = countPeriods(from, goal.targetDate, s);
  const left = goal.target - goal.balance - (goal.otherPerPay ?? 0) * k;
  if (left <= 0) return 0;
  return k > 0 ? Math.ceil(left / k) : left;
}

export function forecast(b: Budget, goal: SavingsGoal, today: ISODate): GoalForecast {
  const s = b.settings;
  const line = b.split.find((l) => l.accountId === goal.accountId);
  const required = requiredPerPay(goal, s, goal.asOf);
  const perPay = modeOf(line) !== 'fixed' ? (required ?? 0) : (line?.amount ?? 0);
  const other = goal.otherPerPay ?? 0;
  // A pay with its own amount (extra from Optimise, or changed for that pay only) sends that instead.
  // Only when this goal has the account to itself: otherwise there's no telling which goal it's for.
  const solo = (b.savings ?? []).filter((g) => g.accountId === goal.accountId).length === 1;
  const sentIn = (p: Period): Cents => ((solo ? b.overrides?.[p.start]?.[goal.accountId] : undefined) ?? perPay) + other;
  const periodsLeft = goal.targetDate ? countPeriods(today, goal.targetDate, s) : undefined;
  // The balance is as at the day it was last updated, so every pay since then is still to be added.
  const from = savedAsOf(goal, today);
  const first = shiftPeriod(periodContaining(from, s), 1, s);
  const pays = goal.targetDate ? countPeriods(from, goal.targetDate, s) : 12;
  let projected = goal.balance;
  for (let i = 0, p = first; i < pays; i++, p = shiftPeriod(p, 1, s)) projected += sentIn(p);

  let reachedBy: ISODate | undefined;
  let remaining: Cents | undefined;
  if (goal.target !== undefined) {
    remaining = Math.max(0, goal.target - goal.balance);
    if (remaining === 0) reachedBy = today;
    else {
      // The pay the balance was updated in is already in it, so add each pay to come until it's there.
      let saved = 0;
      for (let i = 0, p = first; i < 600; i++, p = shiftPeriod(p, 1, s)) {
        saved += sentIn(p);
        if (saved >= remaining) { reachedBy = p.start; break; }
      }
    }
  }
  const onTrack = goal.target !== undefined && goal.targetDate
    ? (reachedBy !== undefined && reachedBy <= goal.targetDate)
    : undefined;
  return { goal, perPay, requiredPerPay: required, periodsLeft, reachedBy, remaining, projected, onTrack };
}

/** Savings needed by an auto savings account in a pay period. */
export function savingsNeedIn(b: Budget, accountId: string, periodStart: ISODate): Cents {
  return (b.savings ?? [])
    .filter((g) => g.accountId === accountId)
    .reduce((t, g) => {
      if (g.targetDate && periodStart >= g.targetDate) return t;
      if (periodStart < periodContaining(g.asOf, b.settings).start) return t; // before we knew the balance
      return t + (requiredPerPay(g, b.settings, g.asOf) ?? 0);
    }, 0);
}

export function accountHasGoals(b: Budget, accountId: string): boolean {
  return (b.savings ?? []).some((g) => g.accountId === accountId && g.target !== undefined && !!g.targetDate);
}

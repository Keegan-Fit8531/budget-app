import { nextColor } from './colors';
import { diffDays, type ISODate } from './dates';
import { periodContaining, shiftPeriod } from './engine';
import type { Payslip } from './payslip';
import type { Budget, Cents, KiwiReading, KiwiStatement, SavingsGoal } from './types';

// ---------------------------------------------------------------------------------------------
// KiwiSaver: a savings goal you don't fund from payday. You and your employer pay in from your
// salary, the government adds its yearly contribution, and nothing is added or taken out by hand.
// What's worth tracking is how the funds do: each balance is kept with the date, and the returns
// between two balances are the change less what went in (from a statement when one says, otherwise
// worked out from your payslips).
// ---------------------------------------------------------------------------------------------

/** A KiwiSaver goal: marked as one, or (unmarked) called KiwiSaver. */
export const isKiwiSaver = (g: Pick<SavingsGoal, 'name' | 'kiwisaver'>): boolean => g.kiwisaver ?? /kiwi\s?saver/i.test(g.name);

/**
 * Employer superannuation contribution tax: taken from your employer's contribution before it reaches
 * the fund, at a rate set by your salary plus that contribution over a year (rates from 1 April 2025).
 */
export function esctRate(yearly: Cents): number {
  const d = yearly / 100;
  return d <= 18_720 ? 0.105 : d <= 64_200 ? 0.175 : d <= 93_720 ? 0.3 : d <= 216_000 ? 0.33 : 0.39;
}

/** What a payslip puts into KiwiSaver: yours, plus your employer's after its tax. Pay is monthly. */
export function slipContribution(slip: Pick<Payslip, 'kiwisaver' | 'employerKiwisaver' | 'taxableGross' | 'net'>): { you: Cents; employer: Cents; total: Cents } {
  const you = slip.kiwisaver ?? 0;
  const gross = slip.employerKiwisaver ?? 0;
  const employer = Math.round(gross * (1 - esctRate(((slip.taxableGross ?? slip.net) + gross) * 12)));
  return { you, employer, total: you + employer };
}

/** The payslip for a pay (by its start), or the nearest one there is. */
function slipNear(b: Pick<Budget, 'payslips'>, start: ISODate): Payslip | undefined {
  const slips = Object.entries(b.payslips ?? {}).filter(([, s]) => s.kiwisaver || s.employerKiwisaver);
  if (!slips.length) return undefined;
  return slips.reduce((best, x) => (Math.abs(diffDays(x[0], start)) < Math.abs(diffDays(best[0], start)) ? x : best))[1];
}

/** What a statement says went in (less withdrawals), or undefined if it doesn't say. */
export function statementIn(s: KiwiStatement): Cents | undefined {
  const parts = [s.employee, s.employer, s.government, s.voluntary];
  if (parts.every((x) => x === undefined)) return undefined;
  return parts.reduce<number>((t, x) => t + (x ?? 0), 0) - (s.withdrawals ?? 0);
}

/** What a statement says the funds earned after tax, or undefined if it doesn't say. */
export function statementEarned(s: KiwiStatement): Cents | undefined {
  if (s.earnings !== undefined) return s.earnings - (s.tax ?? 0);
  return s.returns;
}

/**
 * What went in between two days (after `from`, up to and including `to`). A statement covering the
 * whole stretch gives its average per day; otherwise each payday counts what its payslip (or the
 * nearest payslip) put in. `known` is false when neither says.
 */
export function contributedBetween(b: Pick<Budget, 'settings' | 'payslips'>, goal: SavingsGoal, from: ISODate, to: ISODate): { amount: Cents; known: boolean } {
  for (const r of goal.readings ?? []) {
    const s = r.statement;
    const put = s && statementIn(s);
    if (s && put !== undefined && s.since <= from && r.date >= to && r.date > s.since) {
      return { amount: Math.round((put * diffDays(from, to)) / diffDays(s.since, r.date)), known: true };
    }
  }
  if (!Object.values(b.payslips ?? {}).some((s) => s.kiwisaver || s.employerKiwisaver)) return { amount: 0, known: false };
  let total = 0;
  let p = shiftPeriod(periodContaining(from, b.settings), 1, b.settings);
  for (let n = 0; p.start <= to && n < 1200; n++, p = shiftPeriod(p, 1, b.settings)) {
    const slip = slipNear(b, p.start);
    if (slip) total += slipContribution(slip).total;
  }
  return { amount: total, known: true };
}

/** Add a balance (one a day: a later one that day replaces it, keeping fund values it doesn't give). The newest is the goal's balance. */
export function recordReading(goal: SavingsGoal, r: KiwiReading): void {
  // The balance a goal had before its history was kept (from the bank connection, or typed in) is its first reading.
  if (!goal.readings?.length && goal.balance > 0) goal.readings = [{ date: goal.asOf, balance: goal.balance }];
  const list = (goal.readings = goal.readings ?? []);
  const i = list.findIndex((x) => x.date === r.date);
  if (i >= 0) {
    const was = list[i];
    list[i] = { ...was, ...r, ...(r.funds ? {} : was.funds ? { funds: was.funds } : {}), ...(r.statement ? {} : was.statement ? { statement: was.statement } : {}) };
  } else list.push(r);
  list.sort((x, y) => x.date.localeCompare(y.date));
  for (const name of Object.keys(r.funds ?? {})) {
    if (goal.funds?.some((f) => f.name === name)) continue;
    goal.funds = [...(goal.funds ?? []), { name, color: nextColor((goal.funds ?? []).map((f) => f.color)) }];
  }
  if (r.date >= goal.asOf || list.length === 1) { goal.balance = r.balance; goal.asOf = r.date; }
}

export interface KiwiPoint {
  date: ISODate;
  balance: Cents;
  /** Each fund's value (in the goal's fund order); `estimated` when shared out from another day's split. */
  funds: { name: string; color: string; value: Cents }[];
  fundsEstimated: boolean;
  /** Returns since the first balance. */
  returns: Cents;
  /** What's gone in: the first balance, plus everything paid in since. */
  putIn: Cents;
  /** Returns since the balance before. */
  gain: Cents;
  /** The returns since the balance before are the provider's own figure (from a statement). */
  stated: boolean;
  /** What went in since the balance before was known (a statement or payslips said). */
  inKnown: boolean;
}

/** The goal's balances, oldest first, with each fund's value and the returns between them. */
export function kiwiHistory(b: Pick<Budget, 'settings' | 'payslips'>, goal: SavingsGoal): KiwiPoint[] {
  const readings = [...(goal.readings ?? [])];
  // A balance changed somewhere else (typed into the goal before readings were kept) is a reading too.
  if (!readings.some((r) => r.date === goal.asOf)) readings.push({ date: goal.asOf, balance: goal.balance });
  readings.sort((x, y) => x.date.localeCompare(y.date));
  const order = goal.funds ?? [];
  const out: KiwiPoint[] = [];
  readings.forEach((r, i) => {
    // Fund values: this day's, or the nearest day's split shared out over this balance.
    const own = r.funds && Object.keys(r.funds).length ? r.funds : undefined;
    const near = own ?? [...readings.slice(0, i)].reverse().find((x) => x.funds && Object.keys(x.funds).length)?.funds
      ?? readings.slice(i + 1).find((x) => x.funds && Object.keys(x.funds).length)?.funds;
    let funds: KiwiPoint['funds'] = [];
    let fundsEstimated = false;
    if (near) {
      const sum = Object.values(near).reduce((t, v) => t + v, 0);
      const scale = sum > 0 ? r.balance / sum : 0;
      funds = order.filter((f) => near[f.name] !== undefined).map((f) => ({ name: f.name, color: f.color, value: Math.round(near[f.name] * scale) }));
      fundsEstimated = !own || Math.abs(sum - r.balance) > 100;
    }
    if (i === 0) {
      out.push({ date: r.date, balance: r.balance, funds, fundsEstimated, returns: 0, putIn: r.balance, gain: 0, stated: false, inKnown: true });
      return;
    }
    const prev = out[i - 1];
    const went = contributedBetween(b, goal, prev.date, r.date);
    let returns = prev.returns + (r.balance - prev.balance) - went.amount;
    let stated = false;
    const earned = r.statement && statementEarned(r.statement);
    const from = r.statement ? out.findIndex((p) => p.date === r.statement!.since) : -1;
    if (earned !== undefined && from >= 0) { returns = out[from].returns + earned; stated = from === i - 1; }
    out.push({ date: r.date, balance: r.balance, funds, fundsEstimated, returns, putIn: r.balance - returns, gain: returns - prev.returns, stated, inKnown: went.known || stated });
  });
  return out;
}

/** What goes in each pay, from the latest payslip with KiwiSaver on it. */
export function kiwiPerPay(b: Pick<Budget, 'payslips'>): ReturnType<typeof slipContribution> | undefined {
  const slip = Object.entries(b.payslips ?? {}).filter(([, s]) => s.kiwisaver || s.employerKiwisaver).sort((x, y) => y[0].localeCompare(x[0]))[0]?.[1];
  return slip ? slipContribution(slip) : undefined;
}

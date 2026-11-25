import { fmtShort, monthName } from '../../../core/dates';
import { cash } from '../../../core/money';
import type { Budget, Cents } from '../../../core/types';
import { convert, type View } from '../../../engine/frequency';
import type { Period } from '../../../engine/periods';
import { averageSplit, planFor, plannedAverage, sendsTotal, splitShown, type AccountPlan, type PeriodPlan } from '../../../engine/plan';
import { autoPays, balancePay, type BalanceResult } from '../../../engine/rebalance';
import { owed } from '../../debts/logic/amounts';
import { isHoldDisplayAccount } from '../../debts/logic/funding';
import { existingExtras } from './allocate';

// Everything the Planner page shows for one pay and view, worked out from the budget. The page only draws it.

/** The Planner's view: this pay, or this pay / the next 12 pays shown per week, fortnight, month or year. */
export type PlannerMode = 'period' | View;

/** How amounts are shown in a view. */
export interface ViewScale {
  /** Any view but "this period". */
  avg: boolean;
  /** Week / Fortnight: this pay, split by its number of days. */
  split: boolean;
  /** Month avg / Year: what's planned over the next 12 pays. */
  longRun: boolean;
  /** Days in a week or fortnight (Week / Fortnight views). */
  spanDays: number;
  /** An amount for this pay, in the view's terms. */
  v: (c: Cents) => Cents;
}

export function viewScale(mode: PlannerMode, period: Period): ViewScale {
  const avg = mode !== 'period';
  const split = mode === 'week' || mode === 'fortnight';
  const longRun = mode === 'month' || mode === 'year';
  const spanDays = mode === 'week' ? 7 : 14;
  const v = (c: Cents) => (split ? Math.round((c * spanDays) / period.days) : avg ? convert(c, 'monthly', mode as View) : c);
  return { avg, split, longRun, spanDays, v };
}

/** One line of "What's different this pay": an account sending more or less than usual, and why. */
export interface PayNote { a: AccountPlan; usual: Cents; extra: Cents; why: string[] }

/** The last "Balance this pay" on this page, for the reasons it gave. */
export interface LastBalance { periodStart: string; result: BalanceResult }

/**
 * What's unusual this pay: each account sending noticeably more or less than normal, and why (an extra
 * week, a yearly or one-off cost falling in it, or an amount set for this pay only), biggest first.
 */
export function payNotes(b: Budget, plan: PeriodPlan, usualOf: (id: string) => Cents, last: LastBalance | null): PayNote[] {
  const start = plan.period.start;
  const realItems = new Set(b.items.map((i) => i.id));
  return plan.accounts
    .filter((a) => a.account.id !== b.settings.payAccountId)
    .map((a) => {
      const usual = usualOf(a.account.id);
      const why: string[] = [];
      for (const x of a.breakdown) {
        if (!realItems.has(x.item.id)) continue;
        const f = x.item.frequency;
        if (f === 'yearly' || f === 'once') why.push(`${x.item.name} (${f === 'yearly' ? 'yearly' : 'one-off'}, ${cash(x.item.amount * x.count)}) falls in this pay`);
        else if (f === 'weekly' && x.count >= 5) why.push(`${x.count} weeks of ${x.item.name} instead of 4`);
        else if (f === 'fortnightly' && x.count >= 3) why.push(`${x.count} lots of ${x.item.name} instead of 2`);
      }
      if (a.usual !== undefined && a.usual !== a.funded) {
        why.push(b.autoBalanced?.[start]?.[a.account.id]?.reason
          ?? (last?.periodStart === start ? last.result.changes.find((c) => c.accountId === a.account.id)?.reason : undefined)
          ?? `Adjusted for this pay only (normally ${cash(a.usual)}).`);
      }
      return { a, usual, extra: a.funded - usual, why };
    })
    .filter((x) => Math.abs(x.extra) > 2000 || x.why.length > 0)
    .sort((x, y) => Math.abs(y.extra) - Math.abs(x.extra));
}

/**
 * The payday split's cards. The pay account (Weekly allowance) isn't one: what's left there is the big
 * number. A hold-display debt (Gem with its money in Misc bills) stays even at $0 this pay, while it's owed.
 */
export function paydayCards(b: Budget, plan: PeriodPlan): AccountPlan[] {
  return plan.accounts.filter((a) => {
    if (a.account.id === b.settings.payAccountId) return false;
    if (a.funded !== 0 || a.need !== 0) return true;
    if (!isHoldDisplayAccount(b, a.account.id)) return false;
    return (b.debts ?? []).some((d) => d.accountId === a.account.id && !d.payroll && owed(d) > 0);
  });
}

export interface Slice { label: string; color: string; value: Cents }

/**
 * "Where this pay goes", by group, in the view's terms (`sentOf`). A held debt counts once, under its
 * own group (Debt): see `splitShown`.
 */
export function chartSlices(b: Budget, plan: PeriodPlan, sentOf: (a: AccountPlan) => Cents): Slice[] {
  const shown = splitShown(b, plan.accounts, sentOf);
  const chartOf = (a: AccountPlan) => shown.get(a.account.id) ?? 0;
  const accounts = plan.accounts.filter((a) => a.account.id !== b.settings.payAccountId);
  const grouped = new Set(b.groups.map((g) => g.id));
  return [
    ...b.groups.map((g) => ({ label: g.name, color: g.color, value: accounts.filter((a) => a.account.groupId === g.id).reduce((t, a) => t + chartOf(a), 0) })),
    { label: 'Other', color: 'var(--muted)', value: accounts.filter((a) => !grouped.has(a.account.groupId)).reduce((t, a) => t + chartOf(a), 0) },
  ].filter((x) => x.value > 0);
}

export interface PlannerFigures extends ViewScale {
  plan: PeriodPlan;
  /** The pay you're in now (the Planner opens on the next one to come). */
  isCurrent: boolean;
  /** No payslip yet: the pay is estimated from the last one received. */
  estimated: boolean;
  /** The pay is in, or estimated: what's left can be shown. */
  known: boolean;
  /** Payday has passed (payday itself still counts as to come: pay can land late). */
  paydayEnded: boolean;
  /** Why the pay is an estimate (shown on hover over "Pay (estimate)"). */
  estimateWhy: string;
  notes: PayNote[];
  /** What the accounts usually get, added up (to compare with this pay). */
  usualTotal: Cents;
  /** Month avg / Year: each account's planned average over the next 12 pays (null in the other views). */
  planned: Map<string, { sent: Cents; need: Cents }> | null;
  totalBudgeted: Cents;
  leftover: Cents;
  /** Accounts short this pay. */
  shorts: AccountPlan[];
  cards: AccountPlan[];
  slices: Slice[];
  /** Costs still to come before the pay ends. */
  upcoming: PeriodPlan['dues'];
  /** What "Balance this pay" would do now. */
  pending: BalanceResult;
  /** Something is short, or balancing would still change something. */
  needsBalance: boolean;
  /** Accounts sending a one-pay amount this pay. */
  adjustments: AccountPlan[];
  /** The one-pay amounts you set yourself (not automatic balancing). */
  byHand: AccountPlan[];
  /** Optimise can hand out what's left (a balanced pay with at least $1 over). */
  canOptimise: boolean;
  /** Extra already added to goals, debts or the allowance for this pay only. */
  extrasHere: boolean;
  /** Automatic balancing looks after this pay (today's while it's payday, and the next 11). */
  autoHere: boolean;
  /** After payday, with changes by hand: say to make them as transfers instead. */
  passedNote?: string;
}

export function plannerFigures(b: Budget, period: Period, mode: PlannerMode, today: string, last: LastBalance | null): PlannerFigures {
  const plan = planFor(b, period, today);
  const scale = viewScale(mode, period);
  const { avg, split, longRun, v } = scale;
  const payId = b.settings.payAccountId;

  const estimated = !plan.payIsActual && !!plan.payEstimateFrom;
  const known = plan.payIsActual || estimated;
  const paydayEnded = plan.period.start < today;
  const estimateWhy = estimated
    ? `Using ${monthName(plan.payEstimateFrom!)}'s pay of ${cash(plan.pay)}. ${paydayEnded ? 'Payday has passed: upload the payslip to make it exact.' : `Upload the payslip when it arrives on ${fmtShort(period.start)}.`}`
    : '';

  const usualSplit = new Map(plan.accounts.map((a) => [a.account.id, averageSplit(b, a.account.id)]));
  const usualOf = (id: string) => usualSplit.get(id) ?? 0;
  const notes = payNotes(b, plan, usualOf, last);
  const usualTotal = plan.accounts.filter((a) => a.account.id !== payId).reduce((t, a) => t + usualOf(a.account.id), 0);

  const planned = longRun ? new Map(plan.accounts.map((a) => [a.account.id, plannedAverage(b, a.account.id, today)])) : null;
  const plannedTotal = planned ? sendsTotal(b, plan.accounts, (a) => planned.get(a.account.id)?.sent ?? 0) : 0;
  const totalBudgeted = split ? v(plan.totalSplit) : longRun ? v(plannedTotal) : plan.totalSplit;
  const leftover = split ? v(plan.leftover) : longRun ? v(plan.pay - plannedTotal) : plan.leftover;

  const sentOf = (a: AccountPlan) => Math.max(0, longRun ? v(planned?.get(a.account.id)?.sent ?? 0) : v(a.funded));

  const adjustments = plan.accounts.filter((a) => a.usual !== undefined && a.usual !== a.funded);
  // Once the pay has been split, what automatic balancing set was already sent: only your own changes are left to act on.
  const autoSet = b.autoBalanced?.[period.start] ?? {};
  const byHand = adjustments.filter((a) => autoSet[a.account.id]?.to !== a.funded);
  const pending = balancePay(b, period, today);
  const needsBalance = plan.leftover < 0 || pending.shortAccounts.length > 0 || pending.changes.length > 0 || pending.toSteady.length > 0;
  const payAccountName = b.accounts.find((a) => a.id === payId)?.name ?? 'your main account';
  const passedNote = paydayEnded && byHand.length > 0
    ? `This pay was already split on ${fmtShort(period.start)}. A change made since then isn't sent by payday, so make it as a transfer now, before ${fmtShort(plan.dues.find((d) => d.date >= today)?.date ?? period.end)}: move the money from the accounts being trimmed (or from what's left in ${payAccountName}) to the ones being topped up.`
    : undefined;
  const isCurrent = period.start <= today && today <= period.end;

  return {
    ...scale, plan, isCurrent, estimated, known, paydayEnded, estimateWhy, notes, usualTotal, planned, totalBudgeted, leftover,
    shorts: shortAccounts(b, plan),
    cards: paydayCards(b, plan),
    slices: chartSlices(b, plan, sentOf),
    upcoming: plan.dues.filter((d) => !isCurrent || d.date >= today),
    pending, needsBalance, adjustments, byHand,
    // From $1: rounded accounts often leave a few dollars to put somewhere.
    canOptimise: !avg && !needsBalance && plan.leftover >= 100,
    extrasHere: !avg && !!existingExtras(b, period),
    autoHere: autoPays(b, today).some((p) => p.start === period.start),
    passedNote,
  };
}

/**
 * Accounts payday leaves short this pay ("Gem Visa needs $182 more"). A debt the bank already shows paid
 * enough this pay isn't short: payday sent $133 to Gem, but $700 went to it from ANZ accounts (`Debt.bankPayments`).
 */
export function shortAccounts(b: Budget, plan: PeriodPlan): AccountPlan[] {
  const { start, end } = plan.period;
  return plan.accounts.filter((a) => {
    if (a.diff === null || a.diff >= 0) return false;
    const paid = (b.debts ?? []).filter((d) => d.accountId === a.account.id)
      .flatMap((d) => d.bankPayments ?? []).filter((x) => x.date >= start && x.date <= end).reduce((t, x) => t + x.amount, 0);
    return paid < a.need;
  });
}

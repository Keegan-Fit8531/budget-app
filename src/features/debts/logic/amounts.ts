import { type ISODate } from '../../../core/dates';
import type { Budget, Cents, Debt, PaidPayment, PlanType, Settings } from '../../../core/types';
import { type PerPay, debtSchedules } from './schedule';

/** What payday sends to a debt: its fixed amount, or undefined when it's set to pay what's needed. */
export function debtPerPay(b: Budget, debt: Debt): Cents | undefined {
  if (debt.payroll) return debt.payroll.perPay; // taken from salary each payday
  const line = b.split.find((l) => l.accountId === debt.accountId);
  const mode = line?.mode ?? (line?.auto ? 'exact' : 'fixed');
  if (mode !== 'fixed') return undefined;
  const amount = line?.amount ?? 0;
  // Held in another account with no set figure on the debt card: pay what's due into the hold account.
  if (amount <= 0 && debt.holdAccountId) return undefined;
  return amount;
}

/**
 * What payday sends a debt, with any one-pay amounts (Optimise's "this pay only" extra, or an amount
 * changed for one pay): use this for forecasts, so extra paid in a pay comes off what's owed.
 * A one-pay amount is always on the debt's own card. When the payment is stored in another account until
 * statement day (Gem in Misc bills), that account's one-pay amount is its whole send, which pays its own
 * bills too, so it's never this debt's; the debt's own one goes out from there (`funding.ts` → `debtPaymentsIn`).
 */
export function debtPay(b: Budget, debt: Debt): PerPay {
  const usual = debtPerPay(b, debt);
  if (debt.payroll) return usual;
  const byPeriod: Record<ISODate, Cents> = {};
  for (const [start, o] of Object.entries(b.overrides ?? {})) {
    const v = o?.[debt.accountId];
    // Held in another account: a $0 older versions left on the card would stop that pay's payment, though
    // the money for it is held all the same, so it's left out.
    if (v !== undefined && !(debt.holdAccountId && v <= 0)) byPeriod[start] = v;
  }
  return Object.keys(byPeriod).length ? { usual, byPeriod } : usual;
}

/** What the payment plans still owe, added up. */
export function plannedOwed(debt: Debt): Cents {
  return debt.plans.reduce((t, p) => t + Math.max(0, p.remaining), 0);
}

/** Outstanding balance: the one you entered if there is one, otherwise the plans added up. */
export function owed(debt: Debt): Cents {
  return debt.balance ? debt.balance.amount : plannedOwed(debt);
}

/** Part of the entered balance that isn't covered by any plan (e.g. older purchases). */
export function unplanned(debt: Debt): Cents {
  return Math.max(0, owed(debt) - plannedOwed(debt));
}

/** How many payments already counted as paid are kept for each debt (well over a year's worth). */
export const PAID_KEPT = 300;

/** Planned payments already counted as paid, between two dates (inclusive). */
export function paidIn(debt: Debt, from: ISODate, to: ISODate): PaidPayment[] {
  return (debt.paid ?? []).filter((x) => x.date >= from && x.date <= to);
}

/** A debt's first plan switches its payday amount to "pay exactly what's due". Call after adding the plan. */
export function exactForFirstPlan(b: Budget, debt: Debt): void {
  const line = b.split.find((l) => l.accountId === debt.accountId);
  if (line && debt.plans.length === 1) { line.mode = 'exact'; delete line.auto; }
}

/** Suggested plan type for a new purchase on a card with known rules. */
export function suggestPlan(debt: Debt, amount: Cents): { type: PlanType; months?: number } {
  if (debt.rules === 'afterpay' || debt.kind === 'bnpl') return { type: 'afterpay' };
  if (debt.rules === 'mastercard') return { type: 'interest-free', months: 3 };
  if (debt.rules === 'gem') return amount >= 25000 ? { type: 'interest-free', months: 6 } : { type: 'balance' };
  return { type: 'balance' };
}

/** What a debt is forecast to owe at the end of `date`, from its plans (unplanned balance stays as it is). */
export function projectedOwed(debt: Debt, s: Settings, date: ISODate, perPay?: PerPay): Cents {
  const schedules = debtSchedules(debt, s, perPay);
  let total = schedules.some((x) => x.synthetic) ? 0 : unplanned(debt);
  for (const sch of schedules) {
    let left = Math.max(0, sch.plan.remaining);
    for (const p of sch.payments) { if (p.date <= date) left = p.after; else break; }
    total += left;
  }
  return total;
}

/** What a debt owed at the end of `date` according to its recorded history, if known. */
export function historyOwed(debt: Debt, date: ISODate): Cents | undefined {
  let v: Cents | undefined;
  for (const h of debt.history ?? []) { if (h.asOf <= date) v = h.amount; else break; }
  return v;
}

/** Record today's amount owed in the debt's history (one entry per day; call after any change). */
export function recordHistory(debt: Debt, today: ISODate): void {
  const amount = owed(debt);
  const hist = (debt.history ?? []).filter((h) => h.asOf !== today);
  hist.push({ amount, asOf: today });
  hist.sort((a, b) => a.asOf.localeCompare(b.asOf));
  debt.history = hist.slice(-500);
}

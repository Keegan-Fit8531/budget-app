import { addDays, type ISODate } from '../../../core/dates';
import { periodContaining } from '../../../engine/periods';
import type { Budget, Cents, Debt, PaidPayment, Settings } from '../../../core/types';
import { PAID_KEPT, historyOwed, plannedOwed, recordHistory } from './amounts';
import { gemApply, gemTakeOff, planEnds } from './gem';
import { type PerPay, last, debtSchedules } from './schedule';

export interface Applied { planId: string; planName: string; date: ISODate; amount: Cents; cleared: boolean }

/**
 * Apply a payment to a debt, paying off what's due soonest first (across all its plans).
 * Changes `debt` in place and returns what each part of the payment went to. Anything left over
 * (paying more than is scheduled) reduces an entered balance only.
 */
/** Append planned payments that have gone out, so the pay they belonged to keeps its total. */
export function rememberPaid(debt: Debt, log: PaidPayment[]): void {
  if (!log.length) return;
  debt.paid = [...(debt.paid ?? []), ...log].sort((a, b) => a.date.localeCompare(b.date)).slice(-PAID_KEPT);
}

export function applyPayment(debt: Debt, amount: Cents, s: Settings, date: ISODate): { applied: Applied[]; leftover: Cents } {
  if (debt.rules === 'gem') return gemApply(debt, amount, s, date);
  // Paid on a payday: that's the payday's own payment, so the next one planned is the payday after
  // (dated the day after, the same way a payslip's loan deduction is, so it isn't counted twice).
  const asOf = periodContaining(date, s).start === date ? addDays(date, 1) : date;
  const due = debtSchedules(debt, s)
    .flatMap((sch) => sch.payments.map((p) => ({ plan: sch.plan, date: p.date, amount: p.amount, synthetic: !!sch.synthetic })))
    .sort((a, b) => a.date.localeCompare(b.date) || a.plan.name.localeCompare(b.plan.name));
  let left = amount;
  const applied: Applied[] = [];
  const log: PaidPayment[] = [];
  for (const d of due) {
    if (left <= 0) break;
    const take = Math.min(left, d.amount);
    left -= take;
    const p = d.plan;
    if (p.instalments?.length) {
      const inst = p.instalments.find((i) => i.date === d.date && i.amount > 0);
      if (inst) inst.amount -= take;
      p.instalments = p.instalments.filter((i) => i.amount > 0);
      p.remaining = p.instalments.reduce((t, i) => t + i.amount, 0);
    } else {
      p.remaining = Math.max(0, p.remaining - take);
      p.asOf = later(p.asOf, asOf);
    }
    applied.push({ planId: p.id, planName: p.name, date: d.date, amount: take, cleared: take === d.amount });
    if (take > 0) {
      log.push(d.synthetic
        ? { date: d.date, amount: take, name: p.name, synthetic: true }
        : { date: d.date, amount: take, name: p.name, planId: p.id });
    }
  }
  if (debt.balance) debt.balance = { amount: Math.max(0, debt.balance.amount - amount), asOf: later(debt.balance.asOf, asOf) };
  debt.plans = debt.plans.filter((p) => p.remaining > 0);
  rememberPaid(debt, log);
  recordPaymentHistory(debt, date, amount);
  return { applied, leftover: left };
}

/**
 * A balance lower than the plans add up to means the plans haven't caught up yet (a statement or the
 * card's app gave the balance, but not every plan's figure). The difference comes off the plans the way
 * the card applies a payment, plans not in `trusted` (figures just read) first; plans left at $0 are
 * taken off. No payment is recorded. Returns what came off.
 */
export function fitPlansToBalance(debt: Debt, date: ISODate, trusted: Iterable<string> = []): Cents {
  debt.plans = debt.plans.filter((p) => p.remaining > 0);
  if (!debt.balance) return 0;
  const sure = new Set(trusted);
  const start = plannedOwed(debt) - debt.balance.amount;
  let excess = start;
  // Afterpay-style plans are their instalments: those come from their own screenshot, not a balance.
  const plans = debt.plans.filter((p) => !p.instalments?.length);
  for (const group of [plans.filter((p) => !sure.has(p.id)), plans.filter((p) => sure.has(p.id))]) {
    if (excess <= 0 || !group.length) continue;
    if (debt.rules === 'gem') { excess -= gemTakeOff(debt, new Set(group.map((p) => p.id)), excess, date); continue; }
    for (const p of [...group].sort((a, b) => planEnds(a).localeCompare(planEnds(b)))) {
      const x = Math.min(excess, p.remaining);
      if (x <= 0) break;
      p.remaining -= x; p.asOf = later(p.asOf, date); excess -= x;
    }
  }
  debt.plans = debt.plans.filter((p) => p.remaining > 0);
  return Math.max(0, start) - Math.max(0, excess);
}

export const later = (a: ISODate, b: ISODate): ISODate => (a > b ? a : b);

/**
 * Note a payment made on `date` in the debt's history. Usually that's just today's amount owed. A payment
 * dated before the latest entry (recorded a few days late) brings down what was owed on its day (when
 * there's a record that far back) and on every day since, rather than leaving the later entries as they were.
 */
export function recordPaymentHistory(debt: Debt, date: ISODate, amount: Cents): void {
  const hist = [...(debt.history ?? [])].sort((a, b) => a.asOf.localeCompare(b.asOf));
  if (!hist.some((h) => h.asOf > date)) { recordHistory(debt, date); return; }
  const onDay = historyOwed({ ...debt, history: hist }, date);
  debt.history = [
    ...hist.filter((h) => h.asOf !== date).map((h) => (h.asOf > date ? { ...h, amount: h.amount - amount } : h)),
    ...(onDay !== undefined ? [{ amount: onDay - amount, asOf: date }] : []),
  ].sort((a, b) => a.asOf.localeCompare(b.asOf)).slice(-500);
}

/**
 * Payments are automatic (Afterpay direct debit, card payments from payday), so anything scheduled
 * before today counts as paid. Returns true if anything changed.
 */
export function settleDue(debt: Debt, s: Settings, today: ISODate, perPay?: PerPay): boolean {
  let paid = 0;
  const log: PaidPayment[] = [];
  for (const sch of debtSchedules(debt, s, perPay)) {
    const past = sch.payments.filter((p) => p.date < today);
    if (!past.length) continue;
    const p = sch.plan;
    const total = past.reduce((t, x) => t + x.amount, 0);
    paid += total;
    for (const x of past) if (x.amount > 0) log.push({ date: x.date, amount: x.amount, name: p.name, ...(sch.synthetic ? { synthetic: true } : { planId: p.id }) });
    if (sch.synthetic) continue; // other purchases: comes off the entered balance below
    if (p.instalments?.length) {
      p.instalments = p.instalments.filter((i) => i.date >= today);
      p.remaining = p.instalments.reduce((t, i) => t + i.amount, 0);
    } else {
      p.remaining = last(past)!.after;
      p.asOf = today;
    }
  }
  if (!paid) return false;
  if (debt.balance && debt.balance.asOf < today) debt.balance = { amount: Math.max(0, debt.balance.amount - paid), asOf: today };
  debt.plans = debt.plans.filter((p) => p.remaining > 0);
  // Keep them against the pay they came out of (see `debtPaymentsIn`).
  debt.paid = [...(debt.paid ?? []), ...log].sort((a, b) => a.date.localeCompare(b.date)).slice(-PAID_KEPT);
  recordHistory(debt, today);
  return true;
}

/**
 * A payslip's student loan deduction: brings the payroll-deducted loan's balance down by it (once per
 * payday) and makes it the amount expected each payday from now on. Returns the loan it went to.
 */
export function applyPayrollDeduction(b: Budget, payday: ISODate, amount: Cents): Debt | undefined {
  const debt = (b.debts ?? []).find((d) => d.payroll && d.kind === 'loan');
  if (!debt || !debt.payroll || amount <= 0) return undefined;
  const applied = debt.payroll.applied ?? [];
  debt.payroll.perPay = amount;
  if (applied.includes(payday)) return debt;
  debt.payroll.applied = [...applied, payday].slice(-60);
  if (debt.balance && payday >= debt.balance.asOf) {
    const left = Math.max(0, debt.balance.amount - amount);
    // Dated the day after, so the payday's own deduction isn't counted again.
    debt.balance = { amount: left, asOf: addDays(payday, 1) };
    const hist = (debt.history ?? []).filter((h) => h.asOf !== payday);
    hist.push({ amount: left, asOf: payday });
    debt.history = hist.sort((x, y) => x.asOf.localeCompare(y.asOf)).slice(-500);
  }
  return debt;
}

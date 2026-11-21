import { toDate, toISO, type ISODate } from '../../../core/dates';
import type { Budget, Cents, Debt } from '../../../core/types';
import type { Fig } from '../types';
import { MAX_CENTS, type DraftFig } from './draft';

// ---------- Figures and dates ----------

/** Text as printed → cents. Undefined when blank, null when it isn't a sensible amount. "CR" or a minus means in credit. */
export function toCents(s: string | undefined): { cents: Cents; credit: boolean } | null | undefined {
  const t = (s ?? '').trim();
  if (!t) return undefined;
  const credit = /\bCR\b/i.test(t) || /^[-−(]/.test(t);
  const clean = t.replace(/NZD|CR|DR|[$,\s()−-]/gi, '');
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  const cents = Math.round(parseFloat(clean) * 100);
  return cents > MAX_CENTS ? null : { cents, credit };
}

/** A real YYYY-MM-DD date between 2000 and 2100, or undefined. */
export function validDate(s: string | undefined): ISODate | undefined {
  const t = (s ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return undefined;
  const y = Number(t.slice(0, 4));
  if (y < 2000 || y > 2100) return undefined;
  return toISO(toDate(t)) === t ? t : undefined;
}

export const fig = (f: Fig | undefined): DraftFig => ({ value: f?.amount ?? '', label: f?.label });
export const sameName = (a: string, b: string) => {
  const x = a.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const y = b.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return !!x && !!y && (x.includes(y) || y.includes(x));
};

/** Debts a statement can update: every card and loan, and the student loan (its IRD / myIR balance). */
export const statementDebts = (b: Budget) => (b.debts ?? []).filter((d) => !d.payroll || d.kind === 'loan');
/** The student loan: taken from pay, its balance checked against IRD's. */
export const isStudentLoan = (d: Debt) => !!d.payroll && d.kind === 'loan';
export const afterpayDebt = (b: Budget, id?: string): Debt | undefined =>
  (b.debts ?? []).find((d) => d.id === id && (d.rules === 'afterpay' || d.kind === 'bnpl'))
  ?? (b.debts ?? []).find((d) => d.rules === 'afterpay' || d.kind === 'bnpl');
/** A debt worked out from its orders, with no balance entered (Afterpay). It must never be given a balance. */
export const ordersOnly = (d: Debt) => (d.rules === 'afterpay' || d.kind === 'bnpl') && !d.balance;
/** Debts whose statements list plans that are kept one by one (Gem's interest-free plans). */
export const keepsPlans = (d: Debt) => d.rules === 'gem' || d.plans.some((p) => p.type === 'interest-free' || p.type === 'equal');

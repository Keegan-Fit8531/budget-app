import { fmtDay, ordinal } from '../../../core/dates';
import { type Period } from '../../../engine/periods';
import type { Budget, Cents, Debt } from '../../../core/types';
import { debtPerPay, plannedOwed, owed, unplanned } from './amounts';
import { type PerPay, debtSchedules, fmt } from './schedule';
import { gemPlan } from './gem';

// ---------------------------------------------------------------------------------------------
// Recommended payment per debt, for one pay period — each debt by the logic that suits it.
// ---------------------------------------------------------------------------------------------

export interface DebtAdvice {
  debt: Debt;
  /** What we recommend sending on this payday. */
  recommended: Cents;
  /** What payday is set to send this pay (including any extra for this pay only). */
  sending: Cents;
  /** What it sends each pay, without this pay's one-off amount. */
  usual: Cents;
  /** Extra sent this pay only (e.g. from Optimise), on top of the usual amount. */
  extra?: Cents;
  /** Plain-English reason for the recommendation. */
  reason: string;
  /** The card's own minimum, when it has one. */
  minimum?: Cents;
  /** How "Use recommended" applies it: pay exactly what's due, or set a fixed amount. */
  apply: { mode: 'exact' } | { mode: 'fixed'; amount: Cents };
}

/** True when a debt's payday amount isn't what's recommended (extra on top of it, for one pay, is fine). */
export function offRecommended(a: DebtAdvice): boolean {
  return a.extra ? a.sending < a.recommended : a.sending !== a.recommended;
}

export function debtAdvice(b: Budget, debt: Debt, period: Period): DebtAdvice {
  const s = b.settings;
  const line = b.split.find((l) => l.accountId === debt.accountId);
  const fixed = debtPerPay(b, debt);
  const inPeriod = (perPay?: PerPay) => debtSchedules(debt, s, perPay)
    .flatMap((x) => x.payments).filter((p) => p.date >= period.start && p.date <= period.end)
    .reduce((t, p) => t + p.amount, 0);
  const usual = fixed !== undefined ? fixed : inPeriod();
  const once = debt.payroll ? undefined : b.overrides?.[period.start]?.[debt.accountId];
  const sending = once ?? usual;
  const total = owed(debt);
  const base = { debt, sending, usual, ...(sending > usual ? { extra: sending - usual } : {}) };

  const balanceKnown = !!debt.balance || debt.plans.length > 0 || !!debt.history?.length;
  if (!balanceKnown) {
    return {
      ...base, recommended: usual, apply: { mode: 'fixed', amount: usual },
      reason: 'Enter what\u2019s owed (Update balance) to get a recommendation. Keeping your current amount for now.',
    };
  }
  if (total <= 0) return { ...base, recommended: 0, reason: 'Paid off.', apply: { mode: 'fixed', amount: 0 } };
  if (debt.payroll) {
    return { ...base, recommended: usual, apply: { mode: 'fixed', amount: usual },
      reason: 'Taken from your salary before pay reaches you, so it isn\u2019t part of the payday split.' };
  }

  if (debt.rules === 'gem') {
    const g = gemPlan(debt, s);
    const plansHigh = plannedOwed(debt) > owed(debt) + 100;
    return {
      ...base, recommended: g.recommended, minimum: g.minimum, apply: { mode: 'exact' },
      reason: `Clears every interest-free purchase before it ends (minimum is only ${fmt(g.minimum)}).${debt.statementDay ? ` Send on/after the ${ordinal(debt.statementDay)}.` : ''}${plansHigh ? ' Plan amounts still owed look higher than the card balance — update them to sharpen this figure.' : ''}`,
    };
  }

  const planned = inPeriod(undefined);
  const extra = unplanned(debt);

  if (debt.kind === 'bnpl' || debt.rules === 'afterpay') {
    return {
      ...base, recommended: planned + extra, apply: { mode: 'exact' },
      reason: planned
        ? `Exactly the instalments due ${fmtDay(period.start)} – ${fmtDay(period.end)}, so nothing's late.`
        : 'No instalments due this pay.',
    };
  }

  if (debt.kind === 'person' || debt.kind === 'loan') {
    if (debt.plans.length) {
      return { ...base, recommended: planned, apply: { mode: 'exact' }, reason: 'The repayment you set up, until it’s paid off.' };
    }
    const agreed = line?.amount ?? 0;
    return {
      ...base, recommended: Math.min(agreed, total), apply: { mode: 'fixed', amount: Math.min(agreed, total) },
      reason: agreed ? 'Your agreed amount each pay.' : 'Add an agreed amount to plan repayments.',
    };
  }

  // Other credit cards (e.g. Mastercard, each purchase 3 months interest-free).
  const planPart = debtSchedules(debt, s).filter((x) => !x.synthetic).flatMap((x) => x.payments)
    .filter((p) => p.date >= period.start && p.date <= period.end).reduce((t, p) => t + p.amount, 0);
  const balancePart = planned - planPart;
  const parts: string[] = [];
  if (planPart) parts.push(`${fmt(planPart)} keeps each interest-free purchase on track to clear before it ends`);
  if (balancePart) {
    const autos = debt.rules === 'mastercard' ? debtSchedules(debt, s).filter((x) => x.synthetic && x.deadline) : [];
    parts.push(autos.length
      ? `${fmt(balancePart)} spreads the balance over the pays before its 3 months interest-free ends (${autos.map((x) => fmtDay(x.deadline!)).join(', ')}), so no interest is charged`
      : `${fmt(balancePart)} pays off the balance in full, so no interest is charged`);
  }
  return {
    ...base, recommended: planned, apply: { mode: 'exact' },
    reason: parts.length ? `${parts.join('; ')}.` : extra ? 'The balance is already paid off by an earlier pay.' : 'Nothing due this pay.',
  };
}

import { todayISO, type ISODate } from '../../../core/dates';
import { periodContaining, type Period } from '../../../engine/periods';
import type { Budget, Cents, Debt, DebtPlan } from '../../../core/types';
import { debtSchedules } from './schedule';
import { debtPerPay } from './amounts';
import { debtAdvice } from './advice';

/** Where this debt's payday money sits and its statement-day payment leaves from. */
export function fundingAccountId(debt: Debt): string {
  return debt.holdAccountId || debt.accountId;
}

/** True when this payday account only displays a debt whose money is held in another account. */
export function isHoldDisplayAccount(b: Budget, accountId: string): boolean {
  const mine = (b.debts ?? []).filter((d) => d.accountId === accountId && !d.payroll);
  return mine.length > 0 && mine.every((d) => !!d.holdAccountId);
}

/**
 * Debt payments that leave `accountId` within a date range: the ones still to come, and the ones
 * already counted as paid, so a pay keeps its payments (and its total) after they've gone out.
 * When a debt stores its payment in another account (`holdAccountId`), payments leave that account.
 */
export function debtPaymentsIn(b: Budget, accountId: string, from: ISODate, to: ISODate): { debt: Debt; plan: DebtPlan; date: ISODate; amount: Cents }[] {
  const out: { debt: Debt; plan: DebtPlan; date: ISODate; amount: Cents }[] = [];
  for (const debt of b.debts ?? []) {
    if (fundingAccountId(debt) !== accountId) continue;
    (debt.paid ?? []).forEach((x, i) => {
      if (x.date < from || x.date > to) return;
      // Stands in for the plan it went to (which may be paid off and gone by now).
      const plan: DebtPlan = { id: `${debt.id}-paid-${i}`, name: x.name, type: 'balance', original: x.amount, remaining: 0, asOf: x.date, purchaseDate: x.date };
      out.push({ debt, plan, date: x.date, amount: x.amount });
    });
    // Usual per-pay figure only: a hold account's one-pay override is its whole deposit (Misc bills),
    // not this debt's payment. Optimise extras on the debt card are applied via debtPay in forecasts.
    for (const sch of debtSchedules(debt, b.settings, debtPerPay(b, debt))) {
      for (const p of sch.payments) if (p.date >= from && p.date <= to) out.push({ debt, plan: sch.plan, date: p.date, amount: p.amount });
    }
  }
  return out;
}

/**
 * Put every Gem Visa on "this pay's costs" so statement-day amounts follow Latitude's own allocation
 * (instalments first, then interest-free by expiry — see gemPlan / gemSplit). Returns each debt that
 * changed, for a one-line note on Accounts.
 */
export function syncGemToRecommended(b: Budget, period?: Period): { debt: Debt; from: Cents; to: Cents }[] {
  const p = period ?? periodContaining(todayISO(), b.settings);
  const changed: { debt: Debt; from: Cents; to: Cents }[] = [];
  for (const debt of b.debts ?? []) {
    if (debt.rules !== 'gem' || debt.payroll) continue;
    if (!debt.balance && !debt.plans.length) continue;
    const adv = debtAdvice(b, debt, p);
    if (adv.recommended <= 0) continue;
    const line = b.split.find((l) => l.accountId === debt.accountId);
    if (!line) continue;
    const already = line.mode === 'exact' && (debtPerPay(b, debt) === undefined) && adv.sending === adv.recommended;
    if (already) continue;
    const from = adv.sending;
    line.mode = 'exact';
    delete line.auto;
    line.amount = 0;
    // Clear a one-pay figure on the debt card that was holding it below recommended.
    if (b.overrides?.[p.start]?.[debt.accountId] !== undefined && (b.overrides[p.start][debt.accountId] ?? 0) < adv.recommended) {
      delete b.overrides[p.start][debt.accountId];
      if (!Object.keys(b.overrides[p.start]).length) delete b.overrides[p.start];
    }
    changed.push({ debt, from, to: adv.recommended });
  }
  return changed;
}

export function accountHasPlans(b: Budget, accountId: string): boolean {
  return (b.debts ?? []).some((d) => fundingAccountId(d) === accountId && d.plans.some((p) => p.remaining > 0));
}

/** What payday shows for a debt whose money is held in another account (display amount only). */
export function heldDebtPaymentsIn(b: Budget, accountId: string, from: ISODate, to: ISODate): { debt: Debt; plan: DebtPlan; date: ISODate; amount: Cents }[] {
  const out: { debt: Debt; plan: DebtPlan; date: ISODate; amount: Cents }[] = [];
  for (const debt of b.debts ?? []) {
    if (debt.accountId !== accountId || !debt.holdAccountId) continue;
    out.push(...debtPaymentsIn(b, debt.holdAccountId, from, to).filter((x) => x.debt.id === debt.id));
  }
  return out;
}

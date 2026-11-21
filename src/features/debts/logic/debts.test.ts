import { describe, expect, it } from 'vitest';
import { billTracker } from '../../../engine/balances/billTracker';
import { depositFor } from '../../../engine/balances/deposits';
import { outflows } from '../../../engine/balances/outflows';
import { addDays } from '../../../core/dates';
import { applyPayment, settleDue } from './payments';
import { debtAdvice } from './advice';
import { debtPay, debtPerPay, projectedOwed, paidIn, recordHistory } from './amounts';
import { debtPaymentsIn, syncGemToRecommended } from './funding';
import { debtSchedules, planSchedule } from './schedule';
import { recordStatement } from '../../../services/reader/documents';
import { planFor } from '../../../engine/plan';
import { periodContaining, shiftPeriod } from '../../../engine/periods';
import type { Budget, Debt } from '../../../core/types';
import { budget } from '../../../testing/fixtures';

describe('debts', () => {
  it('a 3-months-interest-free card balance is only paid down once per payday', () => {
    const s = budget().settings;
    const debt: Debt = { id: 'm', name: 'Card', kind: 'card', rules: 'mastercard', accountId: 'm', plans: [], balance: { amount: 90000, asOf: '2026-08-01' } };
    recordHistory(debt, '2026-08-01');
    // The day after the 19 Aug payday its $300 counts as paid…
    expect(settleDue(debt, s, '2026-08-20')).toBe(true);
    expect(debt.balance?.amount).toBe(60000);
    // …and opening the app on later days doesn't take that payday off again.
    for (const day of ['2026-08-21', '2026-08-25', '2026-09-17']) expect(settleDue(debt, s, day)).toBe(false);
    expect(debt.balance?.amount).toBe(60000);
    expect(debtSchedules(debt, s).flatMap((x) => x.payments).map((p) => [p.date, p.amount])).toEqual([['2026-09-18', 30000], ['2026-10-19', 30000]]);
  });

  it('an interest-free plan uses the exact end date when one is entered', () => {
    const s = budget().settings;
    const debt: Debt = { id: 'd', name: 'Card', kind: 'card', accountId: 'd', plans: [] };
    const sch = planSchedule(debt, {
      id: 'p', name: 'Couch', type: 'interest-free', months: 6, original: 60000, remaining: 60000,
      asOf: '2026-11-01', purchaseDate: '2026-11-01', ends: '2027-02-10',
    }, s);
    expect(sch.deadline).toBe('2027-02-10');
    expect(sch.payments.map((p) => p.date)).toEqual(['2026-11-19', '2026-12-18', '2027-01-19']);
  });
});

describe('debt payments that have gone out', () => {
  function withAfterpay() {
    const b = budget();
    b.accounts.push({ id: 'ap', name: 'Afterpay', kind: 'external', color: '#000', groupId: 'debt' });
    b.split.push({ accountId: 'ap', amount: 0, mode: 'exact' });
    b.debts = [{
      id: 'ap', name: 'Afterpay', kind: 'bnpl', rules: 'afterpay', accountId: 'ap',
      plans: [{
        id: 'p', name: 'Shoes', type: 'afterpay', original: 40000, remaining: 30000, asOf: '2026-11-11', purchaseDate: '2026-10-22',
        instalments: [{ date: '2026-11-19', amount: 10000 }, { date: '2026-12-03', amount: 10000 }, { date: '2026-12-17', amount: 10000 }],
      }],
    }];
    return b;
  }
  const sent = (b: Budget, pay: ReturnType<typeof periodContaining>, today: string) => planFor(b, pay, today).accounts.find((a) => a.account.id === 'ap')?.funded;

  it("stay in the pay they came out of, so its total and what's left over don't change as they go", () => {
    const b = withAfterpay();
    const pay = periodContaining('2026-11-19', b.settings);
    const next = shiftPeriod(pay, 1, b.settings);
    const before = planFor(b, pay, '2026-11-18');
    expect(sent(b, pay, '2026-11-18')).toBe(30000);
    // Each day of the pay, as the app does on opening: what fell due before today counts as paid.
    for (let day = pay.start; day <= pay.end; day = addDays(day, 1)) {
      for (const d of b.debts!) settleDue(d, b.settings, day);
      const now = planFor(b, pay, day);
      expect(sent(b, pay, day), day).toBe(30000);
      expect(now.leftover, day).toBe(before.leftover);
      expect(now.dues.map((d) => [d.date, d.item.amount]), day).toEqual([['2026-11-19', 10000], ['2026-12-03', 10000], ['2026-12-17', 10000]]);
      expect(sent(b, next, day), day).toBe(0);
    }
    expect(b.debts![0].plans[0].remaining).toBe(10000); // the 17 Dec one is still to come on the last day
  });

  it("a fixed payment's last pay still shows it after it's paid, and the pay after sends nothing", () => {
    const b = budget();
    b.accounts.push({ id: 'k', name: 'Kim', kind: 'external', color: '#000', groupId: 'debt' });
    b.split.push({ accountId: 'k', amount: 20000, mode: 'fixed' });
    b.debts = [{ id: 'k', name: 'Kim', kind: 'person', accountId: 'k', plans: [], balance: { amount: 20000, asOf: '2026-11-12' } }];
    const pay = periodContaining('2026-11-19', b.settings);
    expect(depositFor(b, 'k', pay, '2026-11-18')).toBe(20000);
    settleDue(b.debts[0], b.settings, '2026-11-20', 20000);
    expect(b.debts[0].balance?.amount).toBe(0);
    expect(depositFor(b, 'k', pay, '2026-11-20')).toBe(20000);
    expect(depositFor(b, 'k', shiftPeriod(pay, 1, b.settings), '2026-11-20')).toBe(0);
  });

  it("an older statement added after a payday doesn't put that payday's payment in its pay twice", () => {
    const b = budget();
    b.accounts.push({ id: 'm', name: 'Card', kind: 'external', color: '#000', groupId: 'debt' });
    b.split.push({ accountId: 'm', amount: 0, mode: 'exact' });
    b.debts = [{ id: 'm', name: 'Card', kind: 'card', rules: 'mastercard', accountId: 'm', plans: [], balance: { amount: 90000, asOf: '2026-11-01' } }];
    recordHistory(b.debts[0], '2026-11-01');
    const pay = periodContaining('2026-11-19', b.settings);
    settleDue(b.debts[0], b.settings, '2026-11-20');
    expect(debtPaymentsIn(b, 'm', pay.start, pay.end).map((x) => [x.date, x.amount])).toEqual([['2026-11-19', 30000]]);
    // A statement as at 10 Nov arrives on the 25th: the 19 Nov payment is worked out again from it.
    recordStatement(b, 'm', { balance: 60000, date: '2026-11-10' }, '2026-11-25');
    expect(paidIn(b.debts[0], pay.start, pay.end).map((x) => x.date)).toEqual(['2026-11-19']);
  });
});

describe('recording a debt payment', () => {
  it('a payment made on payday is that payday\'s payment, not an extra one', () => {
    const s = budget().settings;
    const debt: Debt = {
      id: 'd', name: 'Loan', kind: 'loan', accountId: 'd',
      plans: [{ id: 'p', name: 'Car', type: 'balance', original: 100000, remaining: 100000, asOf: '2026-11-01', purchaseDate: '2026-11-01', payment: 20000 }],
    };
    applyPayment(debt, 20000, s, '2026-11-19');
    expect(debt.plans[0].remaining).toBe(80000);
    expect(debt.paid).toEqual([expect.objectContaining({ date: '2026-11-19', amount: 20000, name: 'Car', planId: 'p' })]);
    expect(settleDue(debt, s, '2026-11-20')).toBe(false);
    expect(debt.plans[0].remaining).toBe(80000);
    expect(planSchedule(debt, debt.plans[0], s).payments[0].date).toBe('2026-12-18');
  });

  it('Gem payment that clears the card keeps the amount on the hold-display pay', () => {
    const b = budget();
    b.accounts.push(
      { id: 'bills', name: 'Misc bills', kind: 'bank', color: '#000', groupId: 'needs' },
      { id: 'gem', name: 'Gem Visa', kind: 'external', color: '#000', groupId: 'debt' },
    );
    b.split.push({ accountId: 'bills', amount: 0, mode: 'exact' }, { accountId: 'gem', amount: 0, mode: 'exact' });
    b.debts = [{
      id: 'gem', name: 'Gem Visa', kind: 'card', rules: 'gem', accountId: 'gem', holdAccountId: 'bills',
      plans: [{ id: 'p1', name: 'TV', type: 'interest-free', original: 100000, remaining: 50400, asOf: '2026-10-01', purchaseDate: '2026-10-01', months: 6 }],
      balance: { amount: 50400, asOf: '2026-11-18' },
      statementDay: 21,
    }];
    const p = periodContaining('2026-11-19', b.settings);
    const before = depositFor(b, 'gem', p, '2026-11-19');
    expect(before).toBeGreaterThan(0);
    // Paying off the whole card clears the Nov 21 schedule; `paid` keeps this pay’s send amount.
    applyPayment(b.debts[0], 50400, b.settings, '2026-11-19');
    expect(b.debts[0].plans).toEqual([]);
    expect(b.debts[0].paid?.some((x) => x.amount === before)).toBe(true);
    expect(depositFor(b, 'gem', p, '2026-11-19')).toBe(before);
  });

  it('a payment between paydays leaves the next payday\'s payment in place', () => {
    const s = budget().settings;
    const debt: Debt = {
      id: 'd', name: 'Loan', kind: 'loan', accountId: 'd',
      plans: [{ id: 'p', name: 'Car', type: 'balance', original: 100000, remaining: 100000, asOf: '2026-11-01', purchaseDate: '2026-11-01', payment: 20000 }],
    };
    applyPayment(debt, 5000, s, '2026-11-10');
    expect(planSchedule(debt, debt.plans[0], s).payments[0]).toMatchObject({ date: '2026-11-19', amount: 20000 });
  });

  it("a payment recorded late, dated before a payday that has since gone out, doesn't bring that payday back", () => {
    const s = budget().settings;
    const debt: Debt = {
      id: 'd', name: 'Loan', kind: 'loan', accountId: 'd',
      plans: [{ id: 'p', name: 'Car', type: 'balance', original: 100000, remaining: 100000, asOf: '2026-11-01', purchaseDate: '2026-11-01', payment: 20000 }],
    };
    recordHistory(debt, '2026-11-01');
    // The 19 Nov payday's $200 counts as paid the day after…
    settleDue(debt, s, '2026-11-20');
    expect(debt.plans[0]).toMatchObject({ remaining: 80000, asOf: '2026-11-20' });
    // …and on the 22nd, an extra $50 paid back on the 15th is recorded.
    applyPayment(debt, 5000, s, '2026-11-15');
    expect(debt.plans[0]).toMatchObject({ remaining: 75000, asOf: '2026-11-20' });
    // The 19 Nov payday isn't planned (and counted as paid) a second time.
    expect(settleDue(debt, s, '2026-11-22')).toBe(false);
    expect(debt.plans[0].remaining).toBe(75000);
    expect(planSchedule(debt, debt.plans[0], s).payments[0].date).toBe('2026-12-18');
    // What was owed comes down from the day it was paid, not just from today.
    expect(debt.history).toEqual([{ amount: 100000, asOf: '2026-11-01' }, { amount: 95000, asOf: '2026-11-15' }, { amount: 75000, asOf: '2026-11-20' }]);
  });

  it("Gem with no statement day: a payment made on payday is that payday's payment, not an extra one", () => {
    const s = budget().settings;
    const debt: Debt = {
      id: 'g', name: 'Gem', kind: 'card', rules: 'gem', accountId: 'g',
      plans: [{ id: 'p', name: 'Couch', type: 'interest-free', months: 6, original: 60000, remaining: 60000, asOf: '2026-11-01', purchaseDate: '2026-11-01' }],
    };
    expect(debtSchedules(debt, s).flatMap((x) => x.payments)[0].date).toBe('2026-11-19');
    applyPayment(debt, 10000, s, '2026-11-19');
    expect(debt.plans[0].remaining).toBe(50000);
    expect(debtSchedules(debt, s).flatMap((x) => x.payments)[0].date).toBe('2026-12-18');
  });
});

describe('Gem payment held in Misc bills until statement day', () => {
  it('Planner still funds Gem’s amount, but the money is in the hold account and only counted once in the payday total', () => {
    const b = budget();
    b.accounts.push(
      { id: 'gem', name: 'Gem Visa', kind: 'external', color: '#000', groupId: b.groups[0].id },
      { id: 'bills', name: 'Misc bills', kind: 'bank', color: '#000', groupId: b.groups[0].id },
    );
    b.split.push({ accountId: 'gem', amount: 0, mode: 'exact' }, { accountId: 'bills', amount: 0, mode: 'exact' });
    b.debts = [{
      id: 'gem', name: 'Gem Visa', kind: 'card', rules: 'gem', accountId: 'gem', holdAccountId: 'bills', statementDay: 21,
      balance: { amount: 180000, asOf: '2026-11-01' },
      plans: [{ id: 'g1', name: 'Purchases', type: 'interest-free', original: 180000, remaining: 180000, asOf: '2026-11-01', purchaseDate: '2026-07-09', ends: '2027-01-20' }],
    }];
    const p = periodContaining('2026-11-19', b.settings);
    const plan = planFor(b, p, '2026-11-19');
    const gem = plan.accounts.find((a) => a.account.id === 'gem')!;
    const bills = plan.accounts.find((a) => a.account.id === 'bills')!;
    expect(gem.funded).toBeGreaterThan(0);
    expect(bills.funded).toBe(gem.funded);
    // Payday total includes Misc bills once, not Gem again.
    expect(plan.totalSplit).toBe(bills.funded);
    expect(debtPaymentsIn(b, 'bills', p.start, p.end).reduce((t, x) => t + x.amount, 0)).toBe(gem.funded);
    expect(debtPaymentsIn(b, 'gem', p.start, p.end)).toEqual([]);
    // Misc bills lists the payment as Gem Visa, noted as stored until statement day / set on the debt.
    const gemLine = bills.dues.find((d) => d.item.name === 'Gem Visa');
    expect(gemLine).toBeTruthy();
    expect(gemLine!.item.note).toMatch(/Stored until the 21st/);
    expect(gemLine!.item.note).toMatch(/set on Gem Visa/);
  });

  it('Gem Visa stays on the payday split when its fixed amount is $0 (pay what’s due into Misc bills)', () => {
    const b = budget();
    b.accounts.push(
      { id: 'gem', name: 'Gem Visa', kind: 'external', color: '#000', groupId: b.groups[0].id },
      { id: 'bills', name: 'Misc bills', kind: 'bank', color: '#000', groupId: b.groups[0].id },
    );
    // A $0 fixed line used to schedule nothing — Gem disappeared from the Planner.
    b.split.push({ accountId: 'gem', amount: 0, mode: 'fixed' }, { accountId: 'bills', amount: 0, mode: 'exact' });
    b.debts = [{
      id: 'gem', name: 'Gem Visa', kind: 'card', rules: 'gem', accountId: 'gem', holdAccountId: 'bills', statementDay: 21,
      balance: { amount: 180000, asOf: '2026-11-01' },
      plans: [{ id: 'g1', name: 'Purchases', type: 'interest-free', original: 180000, remaining: 180000, asOf: '2026-11-01', purchaseDate: '2026-07-09', ends: '2027-01-20' }],
    }];
    const p = periodContaining('2026-11-19', b.settings);
    const plan = planFor(b, p, '2026-11-19');
    const gem = plan.accounts.find((a) => a.account.id === 'gem')!;
    expect(gem.funded).toBeGreaterThan(0);
    expect(gem.need).toBe(gem.funded);
    const cards = plan.accounts.filter((a) => a.account.id !== b.settings.payAccountId && (a.funded !== 0 || a.need !== 0));
    expect(cards.map((a) => a.account.name)).toContain('Gem Visa');
  });

  it('a one-pay override on Gem does not wipe the Planner card when money is held in Misc bills', () => {
    const b = budget();
    b.accounts.push(
      { id: 'gem', name: 'Gem Visa', kind: 'external', color: '#000', groupId: b.groups[0].id },
      { id: 'bills', name: 'Misc bills', kind: 'bank', color: '#000', groupId: b.groups[0].id },
    );
    b.split.push({ accountId: 'gem', amount: 30000, mode: 'fixed' }, { accountId: 'bills', amount: 0, mode: 'exact' });
    b.debts = [{
      id: 'gem', name: 'Gem Visa', kind: 'card', rules: 'gem', accountId: 'gem', holdAccountId: 'bills', statementDay: 21,
      balance: { amount: 180000, asOf: '2026-11-01' },
      plans: [{ id: 'g1', name: 'Purchases', type: 'interest-free', original: 180000, remaining: 180000, asOf: '2026-11-01', purchaseDate: '2026-07-09', ends: '2027-01-20' }],
    }];
    b.overrides = { '2026-11-19': { gem: 0 } };
    const p = periodContaining('2026-11-19', b.settings);
    const plan = planFor(b, p, '2026-11-19');
    const gem = plan.accounts.find((a) => a.account.id === 'gem')!;
    expect(gem.funded).toBeGreaterThan(0);
  });

  it('auto-updates Gem to Latitude’s recommended allocation and reserves that in Misc bills', () => {
    const b = budget();
    b.accounts.push(
      { id: 'gem', name: 'Gem Visa', kind: 'external', color: '#000', groupId: b.groups[0].id },
      { id: 'bills', name: 'Misc bills', kind: 'bank', color: '#000', groupId: b.groups[0].id },
    );
    // Fixed below recommended — used to leave false spare in Misc bills above Haircut max.
    b.split.push({ accountId: 'gem', amount: 50000, mode: 'fixed' }, { accountId: 'bills', amount: 0, mode: 'exact' });
    b.debts = [{
      id: 'gem', name: 'Gem Visa', kind: 'card', rules: 'gem', accountId: 'gem', holdAccountId: 'bills', statementDay: 21,
      balance: { amount: 180000, asOf: '2026-11-01' },
      plans: [{ id: 'g1', name: 'Purchases', type: 'interest-free', original: 180000, remaining: 180000, asOf: '2026-11-01', purchaseDate: '2026-07-09', ends: '2027-01-20' }],
    }];
    b.items.push({ id: 'cut', name: 'Haircut', amount: 2000, frequency: 'monthly', start: '2026-11-01', accountId: 'bills', setAside: true, maxSaved: 6000 });
    const p = periodContaining('2026-11-19', b.settings);
    const adv = debtAdvice(b, b.debts[0], p);
    expect(adv.recommended).toBeGreaterThan(50000);
    // Before sync: outflows still reserve at least recommended (so spare isn’t overstated).
    const gemOut = outflows(b, 'bills', p.start, p.end).filter((o) => o.name === 'Gem Visa').reduce((t, o) => t + o.amount, 0);
    expect(gemOut).toBe(adv.recommended);
    const changed = syncGemToRecommended(b, p);
    expect(changed).toHaveLength(1);
    expect(changed[0].to).toBe(adv.recommended);
    expect(b.split.find((l) => l.accountId === 'gem')).toMatchObject({ mode: 'exact', amount: 0 });
    // On a day in the pay that includes the 21st (not the pay before payday).
    b.balances = { bills: { amount: adv.recommended + 6000 + 5000, asOf: '2026-11-20' } }; // recommended + Haircut max + $50
    const t = billTracker(b, 'bills', '2026-11-20');
    expect(t.toCome).toBeGreaterThanOrEqual(adv.recommended);
    // After Gem and Haircut max, only the $50 above is spare.
    expect(Math.max(0, t.spare - 6000)).toBe(5000);
  });
});

describe('extra paid off a debt for one pay', () => {
  it('Gem: a pay with extra (Optimise, this pay only) pays that much on its statement day, and owes that much less after', () => {
    const b = budget();
    b.accounts.push({ id: 'gem', name: 'Gem', kind: 'external', color: '#000', groupId: b.groups[0].id });
    b.split.push({ accountId: 'gem', amount: 10000, mode: 'fixed' });
    const gem: Debt = {
      id: 'gem', name: 'Gem Visa', kind: 'card', rules: 'gem', accountId: 'gem', statementDay: 21, balance: { amount: 400000, asOf: '2026-11-01' },
      plans: [{ id: 'g1', name: 'Purchases', type: 'interest-free', original: 400000, remaining: 400000, asOf: '2026-11-01', purchaseDate: '2026-07-09', ends: '2028-01-20' }],
    };
    b.debts = [gem];
    const steady = projectedOwed(gem, b.settings, '2027-03-31', debtPerPay(b, gem));
    expect(projectedOwed(gem, b.settings, '2027-03-31', debtPay(b, gem))).toBe(steady);
    b.overrides = { '2027-03-19': { gem: 160000 } };
    const pays = debtSchedules(gem, b.settings, debtPay(b, gem)).flatMap((x) => x.payments);
    expect(pays.find((p) => p.date === '2027-03-21')?.amount).toBe(160000);
    expect(pays.find((p) => p.date === '2027-04-21')?.amount).toBe(10000);
    expect(projectedOwed(gem, b.settings, '2027-03-20', debtPay(b, gem))).toBe(projectedOwed(gem, b.settings, '2027-03-20', debtPerPay(b, gem)));
    expect(projectedOwed(gem, b.settings, '2027-03-31', debtPay(b, gem))).toBe(steady - 150000);
  });
});

import { describe, expect, it } from 'vitest';
import type { Account, Budget } from '../../../core/types';
import { periodContaining } from '../../../engine/periods';
import { planFor, type AccountPlan, type PeriodPlan } from '../../../engine/plan';
import type { BalanceResult } from '../../../engine/rebalance';
import { budget, heldGemBudget } from '../../../testing/fixtures';
import { chartSlices, paydayCards, payNotes, plannerFigures, viewScale } from './plannerFigures';

// Before the pay of 19 Nov starts, so nothing about it is frozen yet.
const today = '2026-11-10';

/** Pay of $5,000 into Everyday; Bills (Essentials) pays $300 a month and a $1,200 yearly cost due in the 19 Nov pay. */
function billsBudget(): Budget {
  const b = budget();
  b.accounts.push(
    { id: 'bills', name: 'Bills', kind: 'bank', color: '#000', groupId: 'needs' },
    { id: 'spare', name: 'Spare', kind: 'bank', color: '#000', groupId: 'savings' },
  );
  b.split.push({ accountId: 'bills', amount: 0, mode: 'exact' }, { accountId: 'spare', amount: 0, mode: 'fixed' });
  b.items.push(
    { id: 'power', name: 'Power', amount: 30000, frequency: 'monthly', start: '2026-01-25', accountId: 'bills' },
    { id: 'ins', name: 'Insurance', amount: 120000, frequency: 'yearly', start: '2025-11-25', accountId: 'bills' },
  );
  return b;
}
const payOf = (b: Budget) => periodContaining('2026-11-20', b.settings);

describe('viewScale', () => {
  it('shows this pay as it is, or split into weeks by its number of days', () => {
    const p = payOf(budget());
    expect(viewScale('period', p).v(30000)).toBe(30000);
    expect(viewScale('week', p).v(p.days * 1000)).toBe(7000);
    expect(viewScale('fortnight', p).split).toBe(true);
    expect(viewScale('month', p).longRun).toBe(true);
  });
});

describe('payNotes', () => {
  it('says when a yearly cost falls in this pay', () => {
    const b = billsBudget();
    const plan = planFor(b, payOf(b), today);
    const notes = payNotes(b, plan, () => 0, null);
    const bills = notes.find((n) => n.a.account.id === 'bills')!;
    expect(bills.why).toContain('Insurance (yearly, $1,200) falls in this pay');
    expect(notes.some((n) => n.a.account.id === 'everyday')).toBe(false);
  });

  it('gives the reason for an amount set for this pay only: balancing\'s own, else "Adjusted"', () => {
    const b = billsBudget();
    b.overrides = { [payOf(b).start]: { spare: 25000 } };
    const plan = planFor(b, payOf(b), today);
    const why = (last: Parameters<typeof payNotes>[3]) => payNotes(b, plan, () => 0, last).find((n) => n.a.account.id === 'spare')!.why;
    expect(why(null)[0]).toMatch(/^Adjusted for this pay only/);
    const last = { periodStart: payOf(b).start, result: { changes: [{ accountId: 'spare', reason: 'Topped up for a short pay.' }] } as unknown as BalanceResult };
    expect(why(last)).toEqual(['Topped up for a short pay.']);
  });
});

// A plan with just the figures these use.
const acct = (id: string, groupId: string): Account => ({ id, name: id, kind: 'bank', color: '#000', groupId });
const row = (account: Account, funded: number, need = 0) => ({ account, funded, need }) as unknown as AccountPlan;
const fakePlan = (rows: AccountPlan[]) => ({ accounts: rows }) as unknown as PeriodPlan;

describe('paydayCards', () => {
  it('leaves out the pay account and accounts with nothing this pay, but keeps a held debt still owed', () => {
    const b = budget();
    b.debts = [{ id: 'gem', name: 'Gem', kind: 'card', accountId: 'gem', holdAccountId: 'bills', plans: [], balance: { amount: 10000, asOf: today } }];
    const plan = fakePlan([row(b.accounts[0], 90000), row(acct('bills', 'needs'), 5000), row(acct('idle', 'needs'), 0), row(acct('gem', 'debt'), 0)]);
    expect(paydayCards(b, plan).map((a) => a.account.id)).toEqual(['bills', 'gem']);
  });
});

describe('chartSlices', () => {
  it('counts a held debt under Debt and takes it out of its hold account, so it is counted once', () => {
    const b = budget();
    b.debts = [{ id: 'gem', name: 'Gem', kind: 'card', accountId: 'gem', holdAccountId: 'bills', plans: [] }];
    const plan = fakePlan([row(b.accounts[0], 90000), row(acct('bills', 'needs'), 50000), row(acct('gem', 'debt'), 20000)]);
    const slices = chartSlices(b, plan, (a) => a.funded);
    expect(slices.map((s) => [s.label, s.value])).toEqual([['Essentials', 30000], ['Debt', 20000]]);
  });

  it('puts accounts in no group under Other', () => {
    const b = budget();
    const slices = chartSlices(b, fakePlan([row(acct('x', 'gone'), 1000)]), (a) => a.funded);
    expect(slices).toEqual([{ label: 'Other', color: 'var(--muted)', value: 1000 }]);
  });
});

describe('plannerFigures', () => {
  it('this pay: totals are the plan\'s, and a pay that is short needs balancing', () => {
    const b = billsBudget();
    b.payActuals[payOf(b).start] = 100000; // $1,000: less than the bills
    const f = plannerFigures(b, payOf(b), 'period', today, null);
    expect(f.known).toBe(true);
    expect(f.totalBudgeted).toBe(f.plan.totalSplit);
    expect(f.leftover).toBe(f.plan.leftover);
    expect(f.leftover).toBeLessThan(0);
    expect(f.needsBalance).toBe(true);
    expect(f.canOptimise).toBe(false);
  });

  it('a pay with money over and nothing to balance can be optimised, in this-pay view only', () => {
    const b = billsBudget();
    b.payActuals[payOf(b).start] = 500000;
    const f = plannerFigures(b, payOf(b), 'period', today, null);
    expect(f.needsBalance).toBe(false);
    expect(f.canOptimise).toBe(true);
    expect(plannerFigures(b, payOf(b), 'week', today, null).canOptimise).toBe(false);
    // Under $1 over: nothing worth handing out.
    b.payActuals[payOf(b).start] = 500000 - f.leftover + 50;
    expect(plannerFigures(b, payOf(b), 'period', today, null).canOptimise).toBe(false);
  });

  it('Month avg: a debt held in another account (Gem in Misc bills) isn\'t taken off the leftover twice', () => {
    const b = heldGemBudget();
    b.payActuals[payOf(b).start] = 500000;
    const f = plannerFigures(b, payOf(b), 'month', today, null);
    const gem = f.planned!.get('gem')!.sent;
    expect(gem).toBeGreaterThan(0);
    // What's budgeted is what the ring shows: Gem once, under Debt.
    expect(Math.abs(f.totalBudgeted - f.slices.reduce((t, s) => t + s.value, 0))).toBeLessThan(10);
    expect(Math.abs(f.leftover + f.totalBudgeted - f.v(f.plan.pay))).toBeLessThan(10);
  });

  it('without a payslip or an earlier pay, nothing is known yet', () => {
    const b = billsBudget();
    const f = plannerFigures(b, payOf(b), 'period', today, null);
    expect(f.known).toBe(false);
    expect(f.estimateWhy).toBe('');
  });
});

import { describe, expect, it } from 'vitest';
import { billTracker } from './balances';
import { addDays } from './dates';
import { debtSchedules, planSchedule, recordHistory, settleDue } from './debts';
import { periodContaining } from './engine';
import { projectedAt } from './goalcosts';
import { forecast } from './savings';
import { seedBudget } from './seed';
import type { Budget, Debt } from './types';

/** A blank budget paid on the 19th, with automatic balancing off so amounts are exactly as set. */
function budget(): Budget {
  const b = structuredClone(seedBudget);
  b.settings.paydayDay = 19;
  b.settings.expectedPay = 500000;
  b.settings.autoBalance = false;
  return b;
}

describe('pay periods', () => {
  it('every date falls inside its own pay period, whatever the payday and weekend rules', () => {
    for (const paydayDay of [1, 2, 15, 19, 28, 29, 30, 31]) {
      for (const saturday of ['friday', 'monday'] as const) {
        for (const sunday of ['friday', 'monday'] as const) {
          const s = { paydayDay, saturday, sunday };
          for (let d = '2024-01-01'; d < '2028-01-01'; d = addDays(d, 1)) {
            const p = periodContaining(d, s);
            expect(p.start <= d && d <= p.end, `${d} with payday ${paydayDay} (${saturday}/${sunday}) got ${p.start} – ${p.end}`).toBe(true);
          }
        }
      }
    }
  });

  it('a payday moved into the next month still starts the right period', () => {
    // Sat 31 May 2025 → paid Mon 2 June, so 1 June is still in the pay that started 30 April.
    const s = { paydayDay: 31, saturday: 'monday' as const, sunday: 'monday' as const };
    expect(periodContaining('2025-06-01', s)).toMatchObject({ start: '2025-04-30', end: '2025-06-01', nextPayday: '2025-06-02' });
    expect(periodContaining('2025-06-02', s).start).toBe('2025-06-02');
  });
});

describe('savings goals', () => {
  function withGoal(target: number) {
    const b = budget();
    b.accounts.push({ id: 'sv', name: 'Savings', kind: 'bank', color: '#000', groupId: 'savings' });
    b.split.push({ accountId: 'sv', amount: 10000, mode: 'fixed' });
    b.savings = [{ id: 'g', name: 'Goal', accountId: 'sv', balance: 0, asOf: '2026-11-12', target, targetDate: '2027-01-20' }];
    return b;
  }

  it('is on track when the pays left before the date are just enough', () => {
    // 12 Nov → 20 Jan: paydays 19 Nov, 18 Dec, 19 Jan. $100 a pay reaches $300 on the third.
    const b = withGoal(30000);
    const f = forecast(b, b.savings![0], '2026-11-12');
    expect(f.reachedBy).toBe('2027-01-19');
    expect(f.onTrack).toBe(true);
  });

  it('is behind when it needs one more pay than there is', () => {
    const b = withGoal(40000);
    const f = forecast(b, b.savings![0], '2026-11-12');
    expect(f.reachedBy).toBe('2027-02-19');
    expect(f.onTrack).toBe(false);
  });

  it('projects from the pays still to come, not the one already in the balance', () => {
    const b = withGoal(30000);
    b.savings![0].balance = 50000;
    expect(projectedAt(b, b.savings![0], '2026-11-18', '2026-11-12')).toEqual({ amount: 50000, pays: 0 });
    expect(projectedAt(b, b.savings![0], '2026-11-19', '2026-11-12')).toEqual({ amount: 60000, pays: 1 });
  });
});

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

describe('bill tracker', () => {
  it('on payday, counts the deposit that lands that day', () => {
    const b = budget();
    b.accounts.push({ id: 'bills', name: 'Bills', kind: 'bank', color: '#000', groupId: 'needs' });
    b.split.push({ accountId: 'bills', amount: 30000, mode: 'fixed' });
    b.items.push({ id: 'i', name: 'Power', amount: 25000, frequency: 'monthly', start: '2026-01-25', accountId: 'bills' });
    b.balances = { bills: { amount: 1000, asOf: '2026-11-12' } };
    const payday = billTracker(b, 'bills', '2026-11-19');
    expect(payday.balance).toBe(31000);
    expect(payday.spare).toBe(6000);
    expect(payday.rows[0].covered).toBe(true);
    expect(billTracker(b, 'bills', '2026-11-20').balance).toBe(31000);
  });
});

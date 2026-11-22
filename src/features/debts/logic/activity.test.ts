import { describe, expect, it } from 'vitest';
import { debtBudget, debt, gemStatement, upload } from '../../../testing/fixtures';
import { monthsUntil, paymentRows, planProgress } from './activity';

describe('a debt card’s activity', () => {
  it('a plan’s progress: paid of its total, and months left of its length', () => {
    const plan = { id: 'p', name: 'Jeweller', type: 'equal' as const, months: 36, original: 200000, remaining: 180000, asOf: '2026-11-22', purchaseDate: '2026-09-11', ends: '2029-09-20' };
    expect(planProgress(plan, '2026-11-22')).toEqual({ paid: 20000, total: 200000, months: 36, monthsLeft: 34 });
    // No length given: worked out from the purchase and its end.
    expect(planProgress({ ...plan, months: undefined, ends: '2027-05-20' }, '2026-11-22')).toMatchObject({ months: 9, monthsLeft: 6 });
    // Afterpay counts instalments instead.
    expect(planProgress({ ...plan, type: 'afterpay' }, '2026-11-22')).toEqual({ paid: 20000, total: 200000 });
    expect(monthsUntil('2026-11-22', '2026-11-22')).toBe(0);
  });

  it('a payment from the bank is pending until the card shows it, then received', () => {
    const b = debtBudget();
    const g = debt(b, 'gem');
    g.bankPayments = [{ date: '2026-11-20', amount: 15000, from: 'bills', counted: 0 }, { date: '2026-11-17', amount: 5000, from: 'weekly', counted: 0 }];
    g.transactions = [{ date: '2026-11-18', description: 'PAYMENT RECEIVED THANK YOU', amount: 5000 }, { date: '2026-11-19', description: 'REFUND SHOP', amount: 1200 }, { date: '2026-11-19', description: 'SHOP', amount: -9000 }];
    const rows = paymentRows(g, true, '2026-11-22');
    expect(rows).toEqual([
      { date: '2026-11-20', amount: 15000, from: 'bills', counted: 0, state: 'pending' },
      { date: '2026-11-19', amount: 1200, description: 'REFUND SHOP', state: 'received', on: '2026-11-19' },
      { date: '2026-11-17', amount: 5000, from: 'weekly', counted: 0, state: 'received', on: '2026-11-18' },
    ]);
    // A card that isn't linked can't say whether it arrived.
    expect(paymentRows({ ...g, transactions: [] }, false, '2026-11-22').every((r) => r.state === undefined)).toBe(true);
    // The card showing it as pending counts, linked or not.
    expect(paymentRows({ ...g, transactions: [], pending: [{ date: '2026-11-21', description: 'PAYMENT', amount: 15000 }] }, false, '2026-11-22')[0].state).toBe('pending');
  });

  it('a statement’s amount to avoid interest is kept on the card; an app screenshot’s isn’t', () => {
    const b = debtBudget();
    const doc = gemStatement('2026-11-21', []);
    doc.statement!.minimum = { amount: '120.00' };
    doc.statement!.avoidInterest = { amount: '640.50' };
    doc.statement!.dueDate = '2026-12-16';
    upload(b, doc, '2026-11-22');
    expect(debt(b, 'gem').statementDue).toEqual({ date: '2026-11-21', minimum: 12000, avoidInterest: 64050, by: '2026-12-16' });
    const shot = gemStatement('2026-11-22', []);
    shot.statement!.appScreen = true;
    shot.statement!.avoidInterest = { amount: '1.00' };
    upload(b, shot, '2026-11-22');
    expect(debt(b, 'gem').statementDue?.avoidInterest).toBe(64050);
  });
});

import { describe, expect, it } from 'vitest';
import { owed } from '../../features/debts/logic/amounts';
import { applyBank } from './bank';
import { cardPaid } from './cardPayments';
import { debtBudget, debt } from '../../testing/fixtures';

describe('card payments seen in a bank account', () => {
  const go = { id: 'a1', name: 'Go', number: '06-0999-0123456-00', type: 'CHECKING', institution: 'ANZ', balance: 500, transactions: true };
  const tx = (id: string, date: string, description: string, amount: number) => ({ account: 'a1', id, date, description, amount, balance: null, merchant: null });
  const links = { a1: 'account:everyday' };

  it('knows a transfer to Gem Visa or Q Mastercard from everything else', () => {
    const b = debtBudget();
    const t = (description: string, amount = -5000) => cardPaid(b, { date: '2026-11-16', description, amount })?.id;
    expect(t('Q Mastercard Fitzgerald Id1105532418')).toBe('qcard');
    expect(t('BP Q Mastercard Fitzgerald ID1105532418')).toBe('qcard');
    expect(t('Gem Visa Fitzgerald K 000000601073 002026242332')).toBe('gem');
    expect(t('BP Gem Visa Fitzgerald K 000000601073')).toBe('gem');
    expect(t('Gem Visa refund', 5000)).toBeUndefined(); // money in isn't a payment
    expect(t('Gemma’s Cafe')).toBeUndefined();
    expect(t('Countdown Henderson')).toBeUndefined();
    expect(t('Student loan')).toBeUndefined(); // repaid from salary, never from the account
  });

  it('a payment over what was planned comes off what’s owed, once', () => {
    const b = debtBudget();
    const data = { accounts: [go], transactions: [tx('t1', '2026-11-15', 'Q Mastercard Fitzgerald Id1105532418', -120)] };
    const r = applyBank(b, data, links, '2026-11-16', '2026-11-16T09:00:00.000Z');
    expect(r[0].cardPayments).toEqual([{ debt: 'Q Mastercard', amount: 12000, date: '2026-11-15', from: 'everyday', counted: 12000 }]);
    expect(owed(debt(b, 'qcard'))).toBe(38000);
    expect(debt(b, 'qcard').bankPayments).toHaveLength(1);
    // The same transfer on the next sync isn't counted again.
    applyBank(b, data, links, '2026-11-17');
    expect(owed(debt(b, 'qcard'))).toBe(38000);
    expect(b.bankSeen?.['account:everyday']).toBeTruthy();
  });

  it('a payment the plan already counts as paid isn’t taken off twice', () => {
    const b = debtBudget();
    const q = debt(b, 'qcard');
    q.paid = [{ date: '2026-11-14', amount: 12000, name: 'Other purchases', synthetic: true }];
    applyBank(b, { accounts: [go], transactions: [tx('t1', '2026-11-15', 'BP Q Mastercard Fitzgerald', -150)] }, links, '2026-11-16');
    expect(owed(q)).toBe(50000 - 3000); // only the $30 over the planned $120
    expect(q.bankPayments?.[0]).toMatchObject({ amount: 15000, counted: 3000 });
  });

  it('a payment you said is still to send isn’t covered by the extra one that paid it early', () => {
    const b = debtBudget();
    const q = debt(b, 'qcard');
    q.paid = [{ date: '2026-11-14', amount: 12000, name: 'Other purchases', synthetic: true }];
    b.billChecks = { 'unpaid|qcard|2026-11-14': '2026-11-15' };
    applyBank(b, { accounts: [go], transactions: [tx('t1', '2026-11-15', 'BP Q Mastercard Fitzgerald', -150)] }, links, '2026-11-16');
    expect(owed(q)).toBe(50000 - 15000); // all of it
    expect(q.bankPayments?.[0]).toMatchObject({ amount: 15000, counted: 15000 });
  });

  it('a balance checked after the payment already has it taken off', () => {
    const b = debtBudget();
    debt(b, 'qcard').balance = { amount: 40000, asOf: '2026-11-16' };
    applyBank(b, { accounts: [go], transactions: [tx('t1', '2026-11-15', 'Q Mastercard', -120)] }, links, '2026-11-16');
    expect(owed(debt(b, 'qcard'))).toBe(40000);
    expect(debt(b, 'qcard').bankPayments?.[0].counted).toBe(0);
  });

  it('old Afterpay payments in a bank account’s history never clear today’s orders', () => {
    const b = debtBudget();
    const ap = debt(b, 'afterpay');
    const before = owed(ap);
    // A sync that brings in a year of history: Afterpay instalments paid long before these orders.
    const old = Array.from({ length: 30 }, (_, i) => tx(`o${i}`, `2025-${String(6 + Math.floor(i / 5)).padStart(2, '0')}-0${1 + (i % 5)}`, 'Afterpay', -41.69));
    applyBank(b, { accounts: [go], transactions: old }, links, '2026-11-16');
    expect(owed(ap)).toBe(before);
    expect(ap.plans).toHaveLength(2);
    expect(ap.bankPayments?.every((p) => p.counted === 0)).toBe(true);
  });

  it('a card linked to the bank itself is left to the bank', () => {
    const b = debtBudget();
    b.bankLinks = { c1: 'debt:qcard' };
    expect(cardPaid(b, { date: '2026-11-16', description: 'Q Mastercard', amount: -100 })).toBeUndefined();
  });

  it('a $50 Q Mastercard transfer is not swallowed by a larger nearby planned payment', () => {
    const b = debtBudget();
    const q = debt(b, 'qcard');
    // Payday already planned $200 for Q; an ad-hoc $50 from ANZ is a separate payment.
    q.paid = [{ date: '2026-11-14', amount: 20000, name: 'Other purchases', synthetic: true }];
    q.balance = { amount: 50000, asOf: '2026-11-10' };
    applyBank(b, { accounts: [go], transactions: [tx('t1', '2026-11-15', 'Q Mastercard Fitzgerald Id1105532418', -50)] }, links, '2026-11-16');
    // Must count the full $50 (a $200 planned nearby must not cover it).
    expect(q.bankPayments?.[0]).toMatchObject({ amount: 5000, counted: 5000 });
    expect((q.bankPayments?.[0].planned ?? []).some((k) => k.includes('|20000|'))).toBe(false);
    expect(owed(q)).toBe(45000);
  });

  it('a pending ANZ transfer to Q Mastercard still reduces what Q owes', () => {
    const b = debtBudget();
    debt(b, 'qcard').balance = { amount: 50000, asOf: '2026-11-10' };
    applyBank(b, {
      accounts: [go],
      transactions: [],
      pending: [{ account: 'a1', date: '2026-11-16', description: 'Q Mastercard Fitzgerald Id1105532418', amount: -50, merchant: null }],
    }, links, '2026-11-16');
    expect(debt(b, 'qcard').bankPayments?.[0]).toMatchObject({ amount: 5000, counted: 5000, date: '2026-11-16' });
    expect(owed(debt(b, 'qcard'))).toBe(45000);
  });
});

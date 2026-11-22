import { describe, expect, it } from 'vitest';
import { applyBank } from '../../../services/bank/bank';
import { debtBudget, debt } from '../../../testing/fixtures';
import { owed } from './amounts';

describe('Gem plans from the card’s own transactions', () => {
  const card = { id: 'c9', name: 'Gem Visa', number: null, type: 'CREDITCARD', institution: 'Latitude', transactions: true };
  const tx = (id: string, date: string, description: string, amount: number) => ({ account: 'c9', id, date, description, amount, balance: null, merchant: null });
  const moved = [
    tx('1', '2026-11-10', 'TAILOR SHOP AUCKLAND NZ', -300), tx('2', '2026-11-13', 'PLAN TRANSFER OUT', 300), tx('3', '2026-11-13', 'PLAN TRANSFER IN', -300),
    tx('4', '2026-11-12', 'CAFE', -20),
  ];

  it('a purchase moved onto a plan becomes one; a big pending one is owed and planned at its full amount', () => {
    const b = debtBudget();
    b.bankLinks = { c9: 'debt:gem' };
    const g = debt(b, 'gem');
    // A plan for the pending purchase that an earlier balance had cut down.
    g.plans.push({ id: 'tv', name: 'TV shop', type: 'interest-free', months: 6, original: 100000, remaining: 40000, asOf: '2026-11-15', purchaseDate: '2026-11-14', ends: '2027-05-20' });
    const pending = [{ account: 'c9', date: '2026-11-14', description: 'TV SHOP', amount: -1000, merchant: null }];
    // $2,400 posted, plus the $1,000 TV still pending.
    applyBank(b, { accounts: [{ ...card, balance: -2400 }], transactions: moved, pending }, b.bankLinks, '2026-11-16');
    expect(owed(g)).toBe(340000);
    expect(g.plans.find((p) => p.id === 'tv')?.remaining).toBe(100000);
    const tailor = g.plans.find((p) => p.purchaseDate === '2026-11-10');
    expect(tailor).toMatchObject({ name: 'Tailor Shop Auckland NZ', type: 'interest-free', months: 6, original: 30000 });
    // The plans already here keep their amounts; the new one takes what's over the balance.
    expect(g.plans.find((p) => p.id === 'g1')?.remaining).toBe(120000);
    expect(g.plans.reduce((t, p) => t + p.remaining, 0)).toBeLessThanOrEqual(340000);
    // A second sync adds nothing.
    const again = JSON.stringify(g.plans);
    applyBank(b, { accounts: [{ ...card, balance: -2400 }], transactions: moved, pending }, b.bankLinks, '2026-11-16');
    expect(JSON.stringify(g.plans)).toBe(again);
  });

  it('a plan paid off is not added back on the next sync', () => {
    const b = debtBudget();
    b.bankLinks = { c9: 'debt:gem' };
    const g = debt(b, 'gem');
    applyBank(b, { accounts: [{ ...card, balance: -2100 }], transactions: moved }, b.bankLinks, '2026-11-16');
    // Owed is what the other plans add up to, so the new one is taken off at once.
    expect(g.plans.some((p) => p.purchaseDate === '2026-11-10')).toBe(false);
    applyBank(b, { accounts: [{ ...card, balance: -2400 }], transactions: [] }, b.bankLinks, '2026-11-17');
    expect(g.plans.some((p) => p.purchaseDate === '2026-11-10')).toBe(false);
  });
});

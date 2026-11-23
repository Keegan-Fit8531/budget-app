import { describe, expect, it } from 'vitest';
import { applyBank } from '../../../services/bank/bank';
import { debtBudget, debt, gemStatement, upload } from '../../../testing/fixtures';
import { owed } from './amounts';

describe('Gem plans from the card’s own transactions', () => {
  const card = { id: 'c9', name: 'Gem Visa', number: null, type: 'CREDITCARD', institution: 'Latitude', transactions: true };
  const tx = (id: string, date: string, description: string, amount: number) => ({ account: 'c9', id, date, description, amount, balance: null, merchant: null });
  /** A purchase Gem moved onto a 6-month plan a few days later. */
  const moved = (n: string, date: string, transfer: string, amount: number) => [
    tx(`${n}a`, date, `SHOP ${n} AUCKLAND NZ`, -amount), tx(`${n}b`, transfer, 'PLAN TRANSFER OUT', amount), tx(`${n}c`, transfer, 'PLAN TRANSFER IN', -amount),
  ];
  const linked = () => { const b = debtBudget(); b.bankLinks = { c9: 'debt:gem' }; return b; };

  it('purchases moved onto a 6-month plan in one statement month are one plan, as at Gem', () => {
    const b = linked();
    const g = debt(b, 'gem');
    const txns = [...moved('1', '2026-11-10', '2026-11-13', 300), ...moved('2', '2026-11-12', '2026-11-15', 400), tx('c', '2026-11-12', 'CAFE', -20)];
    applyBank(b, { accounts: [{ ...card, balance: -2800 }], transactions: txns }, b.bankLinks!, '2026-11-16');
    const month = g.plans.filter((p) => p.id.startsWith('card-'));
    expect(month).toEqual([expect.objectContaining({ name: 'Purchases from Oct 2026 – Nov 2026', type: 'interest-free', months: 6, original: 70000, remaining: 70000, purchaseDate: '2026-11-10', ends: '2027-04-20' })]);
    // Another moved that month joins it; one bought before the 20th but moved after it is next month's plan.
    const more = [...txns, ...moved('3', '2026-11-16', '2026-11-19', 250), ...moved('4', '2026-11-19', '2026-11-22', 100)];
    applyBank(b, { accounts: [{ ...card, balance: -3150 }], transactions: more }, b.bankLinks!, '2026-11-22');
    expect(g.plans.filter((p) => p.id.startsWith('card-'))).toEqual([
      expect.objectContaining({ name: 'Purchases from Oct 2026 – Nov 2026', original: 95000, remaining: 95000 }),
      expect.objectContaining({ name: 'Purchases from Nov 2026 – Dec 2026', original: 10000, remaining: 10000, ends: '2027-05-20' }),
    ]);
    const once = JSON.stringify(g.plans);
    applyBank(b, { accounts: [{ ...card, balance: -3150 }], transactions: more }, b.bankLinks!, '2026-11-22');
    expect(JSON.stringify(g.plans)).toBe(once);
  });

  it('a special deal (posted without a plan transfer, still pending) is owed but left as you set it', () => {
    const b = linked();
    const g = debt(b, 'gem');
    // A 60-month deal set up from a screenshot, cut down earlier by a balance that left the pending purchase out.
    g.plans.push({ id: 'tv', name: 'TV shop', type: 'equal', months: 60, original: 100000, remaining: 40000, asOf: '2026-11-15', purchaseDate: '2026-11-14', ends: '2031-11-20' });
    const pending = [{ account: 'c9', date: '2026-11-14', description: 'TV SHOP', amount: -1000, merchant: null }];
    applyBank(b, { accounts: [{ ...card, balance: -2100 }], transactions: [], pending }, b.bankLinks!, '2026-11-16');
    expect(owed(g)).toBe(310000);
    expect(g.plans.find((p) => p.id === 'tv')).toMatchObject({ type: 'equal', months: 60, remaining: 100000 });
    expect(g.plans.some((p) => p.id.startsWith('card-'))).toBe(false);
  });

  it('a month’s plan paid off is not made again', () => {
    const b = linked();
    const g = debt(b, 'gem');
    const txns = moved('1', '2026-11-10', '2026-11-13', 300);
    // Owed is what the other plans add up to, so the new one comes off at once.
    applyBank(b, { accounts: [{ ...card, balance: -2100 }], transactions: txns }, b.bankLinks!, '2026-11-16');
    expect(g.plans.some((p) => p.id.startsWith('card-'))).toBe(false);
    applyBank(b, { accounts: [{ ...card, balance: -2400 }], transactions: txns }, b.bankLinks!, '2026-11-17');
    expect(g.plans.some((p) => p.id.startsWith('card-'))).toBe(false);
  });

  it('one plan per purchase from an older sync becomes the month’s one plan, with its payments', () => {
    const b = linked();
    const g = debt(b, 'gem');
    const plan = (id: string, date: string, amount: number, left: number) => ({ id, name: id, type: 'interest-free' as const, months: 6, original: amount, remaining: left, asOf: '2026-11-16', purchaseDate: date, ends: '2027-04-20' });
    g.plans.push(plan('card-a', '2026-11-10', 30000, 20000), plan('card-b', '2026-11-12', 40000, 40000));
    g.paid = [{ date: '2026-11-21', amount: 5000, name: 'card-b', planId: 'card-b' }];
    const txns = [...moved('1', '2026-11-10', '2026-11-13', 300), ...moved('2', '2026-11-12', '2026-11-15', 400)];
    applyBank(b, { accounts: [{ ...card, balance: -2700 }], transactions: txns }, b.bankLinks!, '2026-11-22');
    expect(g.plans.filter((p) => p.id.startsWith('card-'))).toEqual([expect.objectContaining({ id: 'card-a', original: 70000, remaining: 60000 })]);
    expect(g.paid?.[0].planId).toBe('card-a');
  });

  it('what the plans add up to over the balance comes off our 6-month guesses first, never a pending purchase’s plan', () => {
    const b = linked();
    const g = debt(b, 'gem');
    // g1 $1,200 and g2 $900 left (from a screenshot), a $300 purchase moved onto a plan, and a $1,000 deal still pending.
    g.plans.push({ id: 'tv', name: 'TV shop', type: 'equal', months: 60, original: 100000, remaining: 100000, asOf: '2026-11-15', purchaseDate: '2026-11-14', ends: '2031-11-20' });
    const pending = [{ account: 'c9', date: '2026-11-14', description: 'TV SHOP', amount: -1000, merchant: null }];
    // Owed $3,300: $100 less than the plans, so $100 has been paid off the new month's plan.
    applyBank(b, { accounts: [{ ...card, balance: -2300 }], transactions: moved('1', '2026-11-10', '2026-11-13', 300), pending }, b.bankLinks!, '2026-11-16');
    expect(g.plans.map((p) => [p.id, p.remaining])).toEqual([['g1', 120000], ['g2', 90000], ['tv', 100000], ['card-2027-04-20', 20000]]);
    const once = JSON.stringify(g.plans);
    applyBank(b, { accounts: [{ ...card, balance: -2300 }], transactions: moved('1', '2026-11-10', '2026-11-13', 300), pending }, b.bankLinks!, '2026-11-16');
    expect(JSON.stringify(g.plans)).toBe(once);
  });

  it('a card app screenshot of today’s balance counts purchases still pending too, and leaves their plans whole', () => {
    const b = linked();
    const g = debt(b, 'gem');
    g.pending = [{ date: '2026-11-14', description: 'TV SHOP', amount: -100000 }];
    g.plans.push({ id: 'tv', name: 'TV shop', type: 'equal', months: 60, original: 100000, remaining: 100000, asOf: '2026-11-15', purchaseDate: '2026-11-14', ends: '2031-11-20' });
    // The app shows $2,100 owed (g1 + g2), leaving out the $1,000 still pending.
    const shot = gemStatement('2026-11-16', [], '2100.00');
    shot.statement!.appScreen = true;
    upload(b, shot, '2026-11-16');
    expect(owed(g)).toBe(310000);
    expect(g.plans.find((p) => p.id === 'tv')?.remaining).toBe(100000);
  });
});

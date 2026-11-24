import { describe, expect, it, vi } from 'vitest';
import { budget, debtBudget, debt } from '../testing/fixtures';
import { tidy } from './upgrade';

describe('tidy (loading an older save)', () => {
  it('turns monthEnvelope (+ envelopeSpan) into envelope', () => {
    const b = budget();
    b.items.push(
      { id: 'gas', name: 'Car gas', amount: 25000, frequency: 'monthly', start: '2026-11-01', accountId: 'x', monthEnvelope: true },
      { id: 'food', name: 'Food shop', amount: 20000, frequency: 'weekly', start: '2026-11-05', accountId: 'x', monthEnvelope: true, envelopeSpan: 'week' },
      { id: 'rent', name: 'Rent', amount: 41500, frequency: 'weekly', start: '2026-11-05', accountId: 'x' },
    );
    tidy(b);
    expect(b.items.map((i) => i.envelope)).toEqual(['month', 'week', undefined]);
    expect(b.items.some((i) => 'monthEnvelope' in i || 'envelopeSpan' in i)).toBe(false);
  });

  it('gives Scooter gas its $40 limit once, and leaves your later change alone', () => {
    const b = budget();
    b.items.push({ id: 's', name: 'Scooter gas', amount: 5000, frequency: 'monthly', start: '2026-11-01', accountId: 'x', envelope: 'month' });
    tidy(b);
    expect(b.items[0].envelopeUnder).toBe(4000);
    delete b.items[0].envelopeUnder;
    tidy(b);
    expect(b.items[0].envelopeUnder).toBeUndefined();
  });

  it('moves the automatic $50 limit to $40, but not one you set or removed yourself', () => {
    const scooter = (under?: number) => ({ id: 's', name: 'Scooter gas', amount: 5000, frequency: 'monthly' as const, start: '2026-11-01', accountId: 'x', envelope: 'month' as const, envelopeUnder: under });
    const b = budget();
    b.flags = ['scooter-gas-under-50'];
    b.items = [scooter(5000)];
    tidy(b);
    expect(b.items[0].envelopeUnder).toBe(4000);
    for (const under of [3000, undefined]) {
      const c = budget();
      c.flags = ['scooter-gas-under-50'];
      c.items = [scooter(under)];
      tidy(c);
      expect(c.items[0].envelopeUnder).toBe(under);
    }
  });

  it('once, brings plans down to a newer balance that’s lower than they add up to', () => {
    const b = debtBudget();
    debt(b, 'gem').balance = { amount: 150000, asOf: '2026-11-16' };
    tidy(b);
    expect(debt(b, 'gem').plans.reduce((t, p) => t + p.remaining, 0)).toBe(150000);
  });

  it('once, moves a card\'s early payment saved under later paydays to the day it was paid (not Gem\'s)', () => {
    vi.setSystemTime(new Date('2026-11-24T00:00:00Z'));
    const b = debtBudget();
    const q = debt(b, 'qcard'), gem = debt(b, 'gem');
    q.bankPayments = [{ date: '2026-11-20', amount: 30000, from: 'weekly', counted: 30000 }];
    q.paid = [{ date: '2026-11-19', amount: 5000, name: 'A' }, { date: '2026-12-18', amount: 5000, name: 'B' }, { date: '2027-01-19', amount: 4000, name: 'C' }];
    gem.paid = [{ date: '2026-12-21', amount: 5000, name: 'TV' }];
    tidy(b);
    expect(q.paid.map((x) => [x.name, x.date])).toEqual([['A', '2026-11-19'], ['B', '2026-11-20'], ['C', '2026-11-20']]);
    expect(gem.paid[0].date).toBe('2026-12-21');
    q.paid.push({ date: '2027-02-19', amount: 1000, name: 'D' });
    tidy(b);
    expect(q.paid[3].date).toBe('2027-02-19');
    vi.useRealTimers();
  });
});

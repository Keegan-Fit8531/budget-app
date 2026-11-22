import { describe, expect, it } from 'vitest';
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

  it('gives Scooter gas its $50 limit once, and leaves your later change alone', () => {
    const b = budget();
    b.items.push({ id: 's', name: 'Scooter gas', amount: 5000, frequency: 'monthly', start: '2026-11-01', accountId: 'x', envelope: 'month' });
    tidy(b);
    expect(b.items[0].envelopeUnder).toBe(5000);
    delete b.items[0].envelopeUnder;
    tidy(b);
    expect(b.items[0].envelopeUnder).toBeUndefined();
  });

  it('once, brings plans down to a newer balance that’s lower than they add up to', () => {
    const b = debtBudget();
    debt(b, 'gem').balance = { amount: 150000, asOf: '2026-11-16' };
    tidy(b);
    expect(debt(b, 'gem').plans.reduce((t, p) => t + p.remaining, 0)).toBe(150000);
  });
});

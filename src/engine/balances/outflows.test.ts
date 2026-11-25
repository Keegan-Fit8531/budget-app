import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forecastBalances } from './estimate';
import { heldGemBudget } from '../../testing/fixtures';

const TODAY = '2026-11-25';
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`)); });
afterEach(() => vi.useRealTimers());

/** How much a Misc bills-style account's projected end balance moves over the next `pays` pays. */
const drift = (b: ReturnType<typeof heldGemBudget>, pays: number) => {
  const ends = forecastBalances(b, 'bills', pays, TODAY).map((r) => r.end!);
  return Math.max(...ends) - Math.min(...ends);
};

describe('a Misc bills account doesn’t build up in later pays', () => {
  it('keeps nothing for Gem once Gem is projected to be paid off', () => {
    // Gem $1,200 over 12 months: paid off in about a year, then nothing more is held for it.
    const b = heldGemBudget();
    b.balances = { bills: { amount: 50000, asOf: TODAY } };
    expect(drift(b, 24)).toBeLessThan(100);
  });

  it('stops putting money aside once a cost’s max is reached', () => {
    // Haircut: $30 a month put aside, up to $60, in a Misc bills that holds Gem (so each pay works out its own amount).
    const b = heldGemBudget();
    b.items.push({ id: 'hair', name: 'Haircut', amount: 3000, frequency: 'monthly', start: '2026-01-01', accountId: 'bills', setAside: true, maxSaved: 6000 });
    b.balances = { bills: { amount: 50000, asOf: TODAY } };
    expect(drift(b, 12)).toBeLessThanOrEqual(6000);
  });
});

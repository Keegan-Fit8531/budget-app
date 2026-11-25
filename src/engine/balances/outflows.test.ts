import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forecastBalances } from './estimate';
import { heldGemBudget } from '../../testing/fixtures';

const TODAY = '2026-11-25';
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`)); });
afterEach(() => vi.useRealTimers());

/** Misc bills (Gem held there, a $100 bill) with `amount` in it today, optionally with Haircut: $30 a month put aside, up to $60. */
function misc(amount: number, haircut = false) {
  const b = heldGemBudget();
  if (haircut) b.items.push({ id: 'hair', name: 'Haircut', amount: 3000, frequency: 'monthly', start: '2026-01-01', accountId: 'bills', setAside: true, maxSaved: 6000 });
  b.balances = { bills: { amount, asOf: TODAY } };
  return b;
}
const ends = (b: ReturnType<typeof misc>, pays: number) => forecastBalances(b, 'bills', pays, TODAY).map((r) => r.end!);

describe('Misc bills sends only what each pay needs, and doesn’t build up', () => {
  it('uses what’s left over, then ends each pay the same (nothing kept for Gem once it’s paid off)', () => {
    // Gem $1,200 over 12 months: paid off in about a year, then nothing more is held for it.
    const e = ends(misc(50000), 24);
    for (let i = 1; i < e.length; i++) expect(e[i]).toBeLessThanOrEqual(e[i - 1]);
    expect(e[e.length - 1]).toBe(0);
  });

  it('keeps money put aside up to its max, and no more', () => {
    const e = ends(misc(50000, true), 24);
    expect(e[e.length - 1]).toBe(6000);
    expect(Math.max(...e.slice(1))).toBeLessThanOrEqual(e[0]);
  });

  it('the next pay sends this pay’s leftover less: with less left than a pay needs, it ends at Haircut’s $60', () => {
    const [now, next, after] = ends(misc(25000, true), 3);
    expect(now).toBeGreaterThan(6000);
    expect(next).toBe(6000);
    expect(after).toBe(6000);
  });
});

describe('pays far ahead', () => {
  it('beyond the 40th pay, each pay still sends what it needs (it used to repeat the 40th’s amount)', () => {
    const b = misc(25000, true);
    b.items.push({ id: 'rego', name: 'Rego', amount: 30000, frequency: 'yearly', start: '2027-04-25', accountId: 'bills' });
    const e = ends(b, 60);
    expect(Math.min(...e)).toBeGreaterThanOrEqual(0);
    expect(e[59]).toBe(6000); // still just Haircut's $60 at the end
  });
});

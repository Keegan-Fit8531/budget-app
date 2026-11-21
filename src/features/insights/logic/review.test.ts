import { describe, expect, it } from 'vitest';
import { addDays } from '../../../core/dates';
import { periodContaining } from '../../../engine/engine';
import { cycleSoFar, lastCycle, makeReview, parseReview, reviewDue, reviewInput, saveReview, KEEP_REVIEWS } from './review';
import { seedBudget } from '../../../core/seed';
import type { Budget } from '../../../core/types';

const words = { headline: 'A steady month.', summary: 'Fine.', good: ['No gambling.'], bad: ['Takeaways.'], tips: ['Cook more.'] };

function withSpending(today: string): Budget {
  const b = structuredClone(seedBudget) as Budget;
  b.settings.budgetStart = undefined;
  const c = lastCycle(b, today);
  const acc = b.accounts[0].id;
  b.accountTransactions = { [acc]: [
    { date: c.start, description: 'POS W/D 1234 PAK N SAV', amount: -8000 },
    { date: addDays(c.start, 3), description: 'MCDONALDS', amount: -1550, merchant: 'McDonald’s' },
    { date: addDays(c.start, 4), description: 'TFR TO SAVINGS', amount: -20000 },
    { date: c.end, description: 'SALARY', amount: 300000 },
    { date: today, description: 'NEW WORLD', amount: -4000 },
  ] };
  b.payActuals = { [c.start]: 400000 };
  return b;
}

describe("this month's insights", () => {
  const today = '2026-11-20';
  it('the last cycle is the pay before today’s, and it’s due once it has transactions', () => {
    const b = withSpending(today);
    const c = lastCycle(b, today);
    expect(c.end < periodContaining(today, b.settings).start).toBe(true);
    expect(addDays(c.end, 1)).toBe(periodContaining(today, b.settings).start);
    expect(reviewDue(b, today)?.start).toBe(c.start);
    expect(reviewDue({ ...b, accountTransactions: {} }, today)).toBeNull();
  });
  it('what’s sent: the cycle’s pay, totals and its purchases (not transfers), nothing after', () => {
    const b = withSpending(today);
    const text = reviewInput(b, lastCycle(b, today));
    expect(text).toContain('Pay (net) this cycle: $4000.00');
    expect(text).toContain('$95.50 over 2 purchases'); // the transfer isn't spending
    expect(text).toMatch(/\|McDonald’s\|15\.50\|Takeaways/);
    expect(text.split('Purchases this cycle')[1]).not.toMatch(/transfer/i);
    expect(text).not.toContain('NEW WORLD'); // today's is in the next cycle
  });
  it('the review keeps the app’s own totals, and a saved one isn’t due again; a so-far one is replaced on payday', () => {
    const b = withSpending(today);
    const c = lastCycle(b, today);
    const r = makeReview(b, c, words, '2026-11-20T01:00:00Z');
    expect(r).toMatchObject({ from: c.start, to: c.end, pay: 400000, spent: 9550, count: 2 });
    expect(r.categories.map((x) => x.label)).toEqual(['Groceries', 'Takeaways and fast food']);
    saveReview(b, { ...r, partial: true });
    expect(reviewDue(b, today)?.start).toBe(c.start);
    saveReview(b, r);
    expect(reviewDue(b, today)).toBeNull();
  });
  it('so far this cycle: from payday to today, marked as part way', () => {
    const b = withSpending(today);
    const s = cycleSoFar(b, today);
    expect(s).toMatchObject({ start: periodContaining(today, b.settings).start, end: today, partial: true });
    expect(reviewInput(b, s)).toContain('NEW WORLD');
    expect(makeReview(b, s, words, 'x').partial).toBe(true);
  });
  it('keeps two years and reads only a usable reply', () => {
    const b = structuredClone(seedBudget) as Budget;
    for (let i = 0; i < 30; i++) saveReview(b, { ...makeReview(withSpending(today), lastCycle(b, today), words, 'x'), from: `2024-${String(i).padStart(2, '0')}` });
    expect(Object.keys(b.reviews!)).toHaveLength(KEEP_REVIEWS);
    expect(parseReview('not json')).toBeNull();
    expect(parseReview('{"headline":""}')).toBeNull();
    expect(parseReview(JSON.stringify({ ...words, good: ['a', 7, ''] }))?.good).toEqual(['a']);
  });
});

describe('sorting shops out of Other', () => {
  it('only unknown shops are sent, with no amounts; guesses fill in, your own choices still win', async () => {
    const { otherShops, shopMap, categorizeTxn } = await import('./spending');
    const { sortInput, parseSorted } = await import('../../../services/reader/sortShops');
    const txns = [
      { date: '2026-11-01', description: 'Tea Talk Syl Card number: 4835', amount: -1281 },
      { date: '2026-11-02', description: 'Tea Talk Syl Card number: 4835', amount: -1230 },
      { date: '2026-11-02', description: 'Maki Mono Sy', amount: -1056 },
      { date: '2026-11-03', description: 'COUNTDOWN HENDERSON', amount: -4520 },
    ];
    const b: { shopCategories?: Record<string, string>; shopGuesses?: Record<string, string> } = {};
    const shops = otherShops(txns, b);
    expect(shops.map((s) => [s.shop, s.count])).toEqual([['Tea Talk', 2], ['Maki Mono', 1]]);
    const sent = sortInput(shops);
    expect(sent).not.toMatch(/12\.81|2026/);
    const got = parseSorted(JSON.stringify({ shops: [{ shop: 'Tea Talk', category: 'eating-out' }, { shop: 'Made up', category: 'shopping' }, { shop: 'Maki Mono', category: 'nonsense' }] }), shops);
    expect(got).toEqual({ 'tea talk': 'eating-out' });
    b.shopGuesses = { ...got, 'maki mono': 'other' };
    expect(categorizeTxn(txns[0], shopMap(b)).category).toBe('eating-out');
    expect(otherShops(txns, b)).toEqual([]); // nothing asked twice
    b.shopCategories = { 'tea talk': 'takeaways' };
    expect(categorizeTxn(txns[0], shopMap(b)).category).toBe('takeaways');
  });
});

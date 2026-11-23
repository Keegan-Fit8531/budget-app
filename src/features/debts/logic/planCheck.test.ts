import { describe, expect, it } from 'vitest';
import { debtBudget, debt } from '../../../testing/fixtures';
import { answerPlan, estimateLeft, planAnswers, planQuestions, undoPlanAnswer } from './planCheck';

describe('Plan check: big Gem purchases the bank can’t say the plan of', () => {
  const today = '2026-11-23';
  const setUp = () => {
    const b = debtBudget();
    const g = debt(b, 'gem');
    g.transactions = [
      // Moved onto a 6-month plan: never asked about.
      { date: '2026-11-10', description: 'TAILOR SHOP AUCKLAND NZ', amount: -30000 },
      { date: '2026-11-13', description: 'PLAN TRANSFER OUT', amount: 30000 }, { date: '2026-11-13', description: 'PLAN TRANSFER IN', amount: -30000 },
      // No transfer: a special deal, or an older 6-month plan.
      { date: '2026-07-26', description: 'IN STORE PURCHASE', amount: -24000 + -6000 },
      // Too small, and too recent for Gem to have moved it yet.
      { date: '2026-11-12', description: 'CAFE', amount: -2000 },
      { date: '2026-11-21', description: 'SHOE SHOP', amount: -26000 },
    ];
    g.pending = [{ date: '2026-11-19', description: 'TV SHOP', amount: -100000 }];
    return { b, g };
  };

  it('asks about a $250+ purchase with no plan transfer, and one pending a few days', () => {
    const { b } = setUp();
    expect(planQuestions(b, today).map((q) => [q.name, q.amount, q.pending])).toEqual([
      ['TV Shop', 100000, true],
      ['In Store Purchase', 30000, false],
    ]);
  });

  it('an answer sets up the plan (or corrects one already here), is never asked again, and can be undone', () => {
    const { b, g } = setUp();
    // A 6-month plan set up wrongly from a screenshot for the pending purchase.
    g.plans.push({ id: 'tv', name: 'TV shop', type: 'interest-free', months: 6, original: 100000, remaining: 60000, asOf: '2026-11-20', purchaseDate: '2026-11-19', ends: '2027-04-20' });
    const [tv, old] = planQuestions(b, today);
    answerPlan(b, tv, 60, 100000, today);
    answerPlan(b, old, 12, 25000, today);
    expect(g.plans.find((p) => p.id === 'tv')).toMatchObject({ type: 'equal', months: 60, remaining: 100000 });
    expect(g.plans.find((p) => p.purchaseDate === '2026-07-26')).toMatchObject({ name: 'In Store Purchase', type: 'equal', months: 12, original: 30000, remaining: 25000, ends: '2027-07-20' });
    expect(planQuestions(b, today)).toEqual([]);
    expect(planAnswers(b).map((a) => a.title)).toContainEqual(expect.stringMatching(/^\$300(\.00)? on 26 Jul 2026: 12-month plan$/));
    undoPlanAnswer(b, 'gem', tv.key);
    expect(g.plans.find((p) => p.id === 'tv')).toMatchObject({ type: 'interest-free', months: 6, remaining: 60000 });
    expect(planQuestions(b, today).map((q) => q.key)).toEqual([tv.key]);
  });

  it('“No plan or paid off” takes off a plan here for it; a special deal already set up isn’t asked about', () => {
    const { b, g } = setUp();
    g.plans.push({ id: 'old', name: 'Old', type: 'interest-free', months: 6, original: 30000, remaining: 30000, asOf: '2026-11-20', purchaseDate: '2026-07-26', ends: '2027-01-20' });
    const old = planQuestions(b, today).find((q) => q.amount === 30000)!;
    answerPlan(b, old, 0, 0, today);
    expect(g.plans.some((p) => p.id === 'old')).toBe(false);
    g.plans.push({ id: 'tv', name: 'TV shop', type: 'equal', months: 60, original: 100000, remaining: 100000, asOf: '2026-11-20', purchaseDate: '2026-11-19', ends: '2031-11-20' });
    expect(planQuestions(b, today)).toEqual([]);
  });

  it('what’s likely left: all of it for 6 months or a recent purchase, else the months still to go', () => {
    const q = { date: '2026-07-26', amount: 30000, pending: false };
    expect(estimateLeft(q, 6, today)).toBe(30000);
    expect(estimateLeft(q, 12, today)).toBe(20000); // 8 of 12 months left
    expect(estimateLeft({ ...q, date: '2025-01-10' }, 12, today)).toBe(0); // ended
  });
});

import { describe, expect, it } from 'vitest';
import { debtBudget, debt } from '../../../../testing/fixtures';
import { answerPlan, planAnswers, planQuestions, undoPlanAnswer } from './planCheck';

describe('Plan check: big Gem purchases the bank can’t say the plan of', () => {
  const today = '2026-11-23';
  /** Gem with g1 ($1,200 left) and g2 ($900), owing `owed`. */
  const setUp = (owed: number) => {
    const b = debtBudget();
    const g = debt(b, 'gem');
    g.balance = { amount: owed, asOf: today };
    g.transactions = [
      // Moved onto a 6-month plan: never asked about.
      { date: '2026-11-10', description: 'TAILOR SHOP AUCKLAND NZ', amount: -30000 },
      { date: '2026-11-13', description: 'PLAN TRANSFER OUT', amount: 30000 }, { date: '2026-11-13', description: 'PLAN TRANSFER IN', amount: -30000 },
      // No transfer: a special deal, or an older 6-month plan.
      { date: '2026-07-26', description: 'IN STORE PURCHASE', amount: -30000 },
      { date: '2026-07-06', description: 'BIKE SHOP', amount: -50000 },
      // Too small, and too recent for Gem to have moved it yet.
      { date: '2026-11-12', description: 'CAFE', amount: -2000 },
      { date: '2026-11-21', description: 'SHOE SHOP', amount: -26000 },
    ];
    g.pending = [{ date: '2026-11-19', description: 'TV SHOP', amount: -100000 }];
    return { b, g };
  };

  it('asks about a $250+ purchase with no plan transfer, and one pending a few days', () => {
    const { b } = setUp(310000);
    expect(planQuestions(b, today).map((q) => [q.name, q.amount, q.pending])).toEqual([
      ['TV Shop', 100000, true],
      ['In Store Purchase', 30000, false],
      ['Bike Shop', 50000, false],
    ]);
  });

  it('an answer only asks the length: what’s left comes from the balance, so an older plan can come out paid off', () => {
    // Owed $3,375: g1 and g2 ($2,100), the TV ($1,000) and $275 more. In Gem's order a month's instalment
    // ($25) comes off the 12-month plan first, then the 6-month plan that ends soonest.
    const { b, g } = setUp(337500);
    const [tv, old, bike] = planQuestions(b, today);
    answerPlan(b, tv, 60, today);
    answerPlan(b, old, 12, today);
    answerPlan(b, bike, 6, today);
    expect(g.plans.find((p) => p.purchaseDate === '2026-11-19')).toMatchObject({ type: 'equal', months: 60, remaining: 100000 });
    expect(g.plans.find((p) => p.purchaseDate === '2026-07-26')).toMatchObject({ name: 'In Store Purchase', type: 'equal', months: 12, original: 30000, remaining: 27500, ends: '2027-07-20' });
    // The 6-month one ends first, so the balance has it paid off; plans set another way keep their amounts.
    expect(g.plans.some((p) => p.purchaseDate === '2026-07-06')).toBe(false);
    expect(g.plans.find((p) => p.id === 'g1')?.remaining).toBe(120000);
    expect(planQuestions(b, today)).toEqual([]);
    expect(planAnswers(b).map((a) => a.title)).toEqual(expect.arrayContaining([
      expect.stringMatching(/^\$300(\.00)? on 26 Jul 2026: 12 months, \$275(\.00)? left$/),
      expect.stringMatching(/^\$500(\.00)? on 6 Jul 2026: 6 months, paid off$/),
    ]));
  });

  it('a plan already here for it is corrected, and Undo puts it back and asks again', () => {
    const { b, g } = setUp(310000);
    // A 6-month plan set up wrongly from a screenshot for the pending purchase.
    g.plans.push({ id: 'tv', name: 'TV shop', type: 'interest-free', months: 6, original: 100000, remaining: 60000, asOf: '2026-11-20', purchaseDate: '2026-11-19', ends: '2027-04-20' });
    const [tv] = planQuestions(b, today);
    answerPlan(b, tv, 60, today);
    // Pending: nothing paid off it yet.
    expect(g.plans.find((p) => p.id === 'tv')).toMatchObject({ type: 'equal', months: 60, remaining: 100000 });
    undoPlanAnswer(b, 'gem', tv.key, today);
    expect(g.plans.find((p) => p.id === 'tv')).toMatchObject({ type: 'interest-free', months: 6 });
    expect(planQuestions(b, today).map((q) => q.key)).toContain(tv.key);
  });

  it('“No plan” takes off a plan here for it; a special deal already set up isn’t asked about', () => {
    const { b, g } = setUp(310000);
    g.plans.push({ id: 'old', name: 'Old', type: 'interest-free', months: 6, original: 30000, remaining: 30000, asOf: '2026-11-20', purchaseDate: '2026-07-26', ends: '2027-01-20' });
    const old = planQuestions(b, today).find((q) => q.amount === 30000)!;
    answerPlan(b, old, 0, today);
    expect(g.plans.some((p) => p.id === 'old')).toBe(false);
    g.plans.push({ id: 'tv', name: 'TV shop', type: 'equal', months: 60, original: 100000, remaining: 100000, asOf: '2026-11-20', purchaseDate: '2026-11-19', ends: '2031-11-20' });
    expect(planQuestions(b, today).map((q) => q.name)).toEqual(['Bike Shop']);
  });
});

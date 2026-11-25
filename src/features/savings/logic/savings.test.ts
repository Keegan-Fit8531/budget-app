import { describe, expect, it } from 'vitest';
import { projectedAt, removeSpend, savedToday, spendFromGoal } from './goalcosts';
import { saveGift } from './gifts';
import { forecast } from './savings';
import type { SavingsGoal } from '../../../core/types';
import { budget } from '../../../testing/fixtures';

describe('savings goals', () => {
  function withGoal(target: number) {
    const b = budget();
    b.accounts.push({ id: 'sv', name: 'Savings', kind: 'bank', color: '#000', groupId: 'savings' });
    b.split.push({ accountId: 'sv', amount: 10000, mode: 'fixed' });
    b.savings = [{ id: 'g', name: 'Goal', accountId: 'sv', balance: 0, asOf: '2026-11-12', target, targetDate: '2027-01-20' }];
    return b;
  }

  it('is on track when the pays left before the date are just enough', () => {
    // 12 Nov → 20 Jan: paydays 19 Nov, 18 Dec, 19 Jan. $100 a pay reaches $300 on the third.
    const b = withGoal(30000);
    const f = forecast(b, b.savings![0], '2026-11-12');
    expect(f.reachedBy).toBe('2027-01-19');
    expect(f.onTrack).toBe(true);
  });

  it('is behind when it needs one more pay than there is', () => {
    const b = withGoal(40000);
    const f = forecast(b, b.savings![0], '2026-11-12');
    expect(f.reachedBy).toBe('2027-02-19');
    expect(f.onTrack).toBe(false);
  });

  it('projects from the pays still to come, not the one already in the balance', () => {
    const b = withGoal(30000);
    b.savings![0].balance = 50000;
    expect(projectedAt(b, b.savings![0], '2026-11-18', '2026-11-12')).toEqual({ amount: 50000, pays: 0 });
    expect(projectedAt(b, b.savings![0], '2026-11-19', '2026-11-12')).toEqual({ amount: 60000, pays: 1 });
  });

  it('a payday that has passed since the balance was updated still counts', () => {
    // $0 saved on 12 Nov, $100 a pay: 19 Nov, 18 Dec and 19 Jan make $300 by 20 Jan.
    const b = withGoal(30000);
    const g = b.savings![0];
    expect(projectedAt(b, g, '2027-01-20', '2026-11-12').amount).toBe(30000);
    // After the 19 Nov payday, with the balance not updated yet: the same, not a pay short.
    expect(projectedAt(b, g, '2027-01-20', '2026-11-25')).toEqual({ amount: 30000, pays: 3 });
    expect(forecast(b, g, '2026-11-25')).toMatchObject({ onTrack: true, reachedBy: '2027-01-19', projected: 30000, periodsLeft: 2 });
    // Once it's updated (that payday's $100 is in it), the pay isn't added a second time.
    g.balance = 10000; g.asOf = '2026-11-25';
    expect(projectedAt(b, g, '2027-01-20', '2026-11-25')).toEqual({ amount: 30000, pays: 2 });
    expect(forecast(b, g, '2026-11-25')).toMatchObject({ onTrack: true, reachedBy: '2027-01-19', projected: 30000 });
  });

  it('counts extra sent for one pay only (Optimise) in the forecast', () => {
    // $100 a pay, plus $100 extra in the 18 Dec pay: $400 by 19 Jan instead of $300.
    const b = withGoal(40000);
    b.overrides = { '2026-12-18': { sv: 20000 } };
    const f = forecast(b, b.savings![0], '2026-11-12');
    expect(f).toMatchObject({ reachedBy: '2027-01-19', onTrack: true, projected: 40000 });
  });
});

describe('spending from a goal, and undoing it', () => {
  // $100 saved as at 1 Nov; $100 goes to it each payday (fixed).
  const setup = () => {
    const b = budget();
    b.accounts.push({ id: 'sv', name: 'Savings', kind: 'bank', color: '#000', groupId: 'savings' });
    b.split.push({ accountId: 'sv', amount: 10000, mode: 'fixed' });
    const g: SavingsGoal = { id: 'g', name: 'G', accountId: 'sv', balance: 10000, asOf: '2026-11-01', costs: [{ id: 'c', name: 'C', amount: 50000, category: 'x' }] };
    b.savings = [g];
    return { b, g };
  };

  it('can put the money back', () => {
    const { b, g } = setup();
    spendFromGoal(b, g, { id: 's', amount: 4000, date: '2026-11-12' }, { costId: 'c' }, '2026-11-12');
    removeSpend(b, g, 'c', 's', true, '2026-11-12');
    expect(g.balance).toBe(10000);
  });

  it('can leave the balance alone (e.g. the spend was more than was saved)', () => {
    const { b, g } = setup();
    spendFromGoal(b, g, { id: 's', amount: 30000, date: '2026-11-12' }, { costId: 'c' }, '2026-11-12');
    expect(g.balance).toBe(0);
    removeSpend(b, g, 'c', 's', false, '2026-11-12');
    expect(g.balance).toBe(0);
    expect(g.costs?.[0].spends).toEqual([]);
  });

  it("a spend dated ahead doesn't date the balance ahead (the paydays before it would stop counting)", () => {
    const { b, g } = setup();
    spendFromGoal(b, g, { id: 's', amount: 1000, date: '2026-12-25' }, { costId: 'c' }, '2026-11-12');
    expect(g).toMatchObject({ balance: 9000, asOf: '2026-11-12' });
  });

  it("keeps the paydays since the balance was last updated: only what's spent comes off", () => {
    // On 25 Nov the fund has the $100 saved and the 19 Nov payday's $100 in it.
    const { b, g } = setup();
    expect(savedToday(b, g, '2026-11-25')).toBe(20000);
    spendFromGoal(b, g, { id: 's', amount: 5000, date: '2026-11-25' }, { costId: 'c' }, '2026-11-25');
    expect(g).toMatchObject({ balance: 15000, asOf: '2026-11-25' });
    expect(projectedAt(b, g, '2026-12-20', '2026-11-25').amount).toBe(25000); // and 18 Dec's on top
    removeSpend(b, g, 'c', 's', true, '2026-11-25');
    expect(savedToday(b, g, '2026-11-25')).toBe(20000);
  });

  it('money in or out keeps them too', () => {
    const { b, g } = setup();
    saveGift(b, 'g', { id: 'x', amount: 2500, date: '2026-11-25', received: true }, undefined, '2026-11-25');
    expect(g).toMatchObject({ balance: 22500, asOf: '2026-11-25' });
  });
});

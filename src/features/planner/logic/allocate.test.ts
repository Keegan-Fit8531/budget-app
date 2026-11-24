import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyAllocation, existingExtras, undoAllocation } from './allocate';
import { planFor } from '../../../engine/plan';
import { periodContaining } from '../../../engine/periods';
import type { Budget } from '../../../core/types';
import { budget, heldGemBudget } from '../../../testing/fixtures';
import { debtPay, projectedOwed } from '../../debts/logic/amounts';

describe('optimising the leftover, then changing it', () => {
  function twoGoals() {
    const b = budget();
    for (const id of ['a', 'b']) {
      b.accounts.push({ id, name: id, kind: 'bank', color: '#000', groupId: 'savings' });
      b.split.push({ accountId: id, amount: 10000, mode: 'fixed' });
    }
    b.savings = ['a', 'b'].map((id) => ({ id, name: id, accountId: id, balance: 0, asOf: '2026-11-12' }));
    return b;
  }
  const funded = (b: Budget, p: ReturnType<typeof periodContaining>, id: string) => planFor(b, p).accounts.find((a) => a.account.id === id)!.funded;
  // Once payday has passed, planFor freezes the pay's split (splitSent), one-pay amounts there at the time
  // included, so what these see depends on the day. They run on fixed days rather than today: before the
  // pay of the 19th starts (its split still worked out live) and after it (its split frozen).
  const onDay = (day: string) => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(`${day}T12:00:00`)); };
  afterEach(() => { vi.useRealTimers(); });

  for (const [when, day] of [['before payday', '2026-11-18'], ['after payday, split frozen', '2026-11-25']]) {
    describe(when, () => {
      beforeEach(() => onDay(day));

      it('this pay only: editing swaps the old amounts for the new ones', () => {
        const b = twoGoals();
        const p = periodContaining('2026-11-20', b.settings);
        const start = planFor(b, p).leftover;
        const first = applyAllocation(b, p, [{ targetId: 'goal-a', amount: 30000 }], 'once');
        expect(planFor(b, p).leftover).toBe(start - 30000);
        // Edit: put back what Optimise did, then hand it out again.
        undoAllocation(b, first);
        expect(planFor(b, p).leftover).toBe(start);
        applyAllocation(b, p, [{ targetId: 'goal-a', amount: 5000 }, { targetId: 'goal-b', amount: 20000 }], 'once');
        expect(funded(b, p, 'a')).toBe(15000);
        expect(funded(b, p, 'b')).toBe(30000);
        expect(planFor(b, p).leftover).toBe(start - 25000);
      });

      it('finds extra already added for this pay only, so Optimise can hand it out again', () => {
        const b = twoGoals();
        const p = periodContaining('2026-11-20', b.settings);
        b.overrides = { [p.start]: { a: 40000 } }; // $300 on top of the usual $100, set without Optimise
        const start = planFor(b, p).leftover;
        const x = existingExtras(b, p)!;
        expect(x.allocs).toEqual([{ targetId: 'goal-a', amount: 30000 }]);
        // Hand it all out again: $200 back to goal a, $100 plus what was left to goal b.
        undoAllocation(b, x);
        expect(planFor(b, p).leftover).toBe(start + 30000);
        applyAllocation(b, p, [{ targetId: 'goal-a', amount: 20000 }, { targetId: 'goal-b', amount: 10000 + start }], 'once');
        expect(funded(b, p, 'a')).toBe(30000);
        expect(planFor(b, p).leftover).toBe(0);
        // An amount set lower than usual isn't extra.
        b.overrides = { [p.start]: { a: 5000 } };
        expect(existingExtras(b, p)).toBeNull();
      });

      it('opening Optimise on extra already added and saving it unchanged adds nothing more', () => {
        const b = twoGoals();
        const p = periodContaining('2026-11-20', b.settings);
        b.overrides = { [p.start]: { a: 40000 } };
        const start = planFor(b, p).leftover;
        // What Optimise does on Save: put back what it found, then hand the same amounts out again.
        const x = existingExtras(b, p)!;
        undoAllocation(b, x);
        applyAllocation(b, p, x.allocs, 'once');
        expect(funded(b, p, 'a')).toBe(40000);
        expect(planFor(b, p).leftover).toBe(start);
      });

      it('every pay: editing changes the normal amount rather than adding to it', () => {
        const b = twoGoals();
        const p = periodContaining('2026-11-20', b.settings);
        const first = applyAllocation(b, p, [{ targetId: 'goal-a', amount: 30000 }], 'every');
        expect(b.split.find((l) => l.accountId === 'a')!.amount).toBe(40000);
        undoAllocation(b, first);
        applyAllocation(b, p, [{ targetId: 'goal-a', amount: 10000 }], 'every');
        expect(b.split.find((l) => l.accountId === 'a')!.amount).toBe(20000);
      });
    });
  }

  it('this pay only, chosen before payday and undone after it: the frozen split gives the money back', () => {
    const b = twoGoals();
    const p = periodContaining('2026-11-20', b.settings);
    onDay('2026-11-18');
    const start = planFor(b, p).leftover;
    const u = applyAllocation(b, p, [{ targetId: 'goal-a', amount: 30000 }], 'once');
    onDay('2026-11-25');
    expect(planFor(b, p).leftover).toBe(start - 30000);
    expect(b.splitSent?.[p.start]).toMatchObject({ a: 40000, b: 10000 }); // payday split it with the $300 in
    undoAllocation(b, u);
    expect(funded(b, p, 'a')).toBe(10000);
    expect(planFor(b, p).leftover).toBe(start);
    expect(b.splitSent?.[p.start]?.b).toBe(10000); // the rest of the frozen split is left alone
  });

  it('this pay only, to Gem held in Misc bills: Misc bills sends it, and it comes off Gem in the forecast', () => {
    const b = heldGemBudget();
    const p = periodContaining('2026-12-20', b.settings);
    const today = '2026-11-25';
    const was = planFor(structuredClone(b), p, today);
    const bills = (x: typeof was) => x.accounts.find((a) => a.account.id === 'bills')!.funded;
    const owedBy = (when: string) => projectedOwed(b.debts![0], b.settings, when, debtPay(b, b.debts![0]));
    const owedBefore = owedBy('2027-01-01');
    const u = applyAllocation(b, p, [{ targetId: 'debt-gem', amount: 10000 }], 'once');
    const now = planFor(b, p, today);
    expect(now.leftover).toBe(was.leftover - 10000);
    expect(bills(now)).toBe(bills(was) + 10000);
    expect(owedBy('2027-01-01')).toBe(owedBefore - 10000);
    undoAllocation(b, u);
    expect(planFor(b, p, today).leftover).toBe(was.leftover);
  });
});

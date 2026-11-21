import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyAllocation, existingExtras, undoAllocation } from './allocate';
import { planFor } from '../../../engine/plan';
import { periodContaining } from '../../../engine/periods';
import type { Budget } from '../../../core/types';
import { budget } from '../../../testing/fixtures';

describe('optimising the leftover, then changing it', () => {
  // These are about the 19 Nov 2026 pay while it's still to come. Once its payday has passed the pay is
  // locked (what payday sent is frozen, engine/balances/freeze.ts), so fix "today" before it rather than
  // use the real date. Without this the second test started failing on 20 Nov 2026.
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-16T09:00:00Z')); });
  afterEach(() => { vi.useRealTimers(); });

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

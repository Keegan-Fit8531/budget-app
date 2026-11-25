import { describe, expect, it } from 'vitest';
import { depositFor } from '../../../engine/balances/deposits';
import { morningFlag } from '../../../engine/balances/freeze';
import { periodContaining } from '../../../engine/periods';
import { planFor } from '../../../engine/plan';
import { budget } from '../../../testing/fixtures';
import { resetPay, setThisPay } from './thisPay';

// Spare (fixed $100 a pay) is set to $250 for the 19 Nov pay only.
function spareBudget() {
  const b = budget();
  b.accounts.push({ id: 'spare', name: 'Spare', kind: 'bank', color: '#000', groupId: 'savings' });
  b.split.push({ accountId: 'spare', amount: 10000, mode: 'fixed' });
  return b;
}
const pay = (b: ReturnType<typeof budget>) => periodContaining('2026-11-20', b.settings);

describe('amounts for one pay only', () => {
  for (const [when, today] of [['before payday', '2026-11-12'], ['after payday, split frozen', '2026-11-25']]) {
    it(`Reset to defaults puts the usual amount back (${when})`, () => {
      const b = spareBudget();
      const p = pay(b);
      planFor(b, p, today); // after payday this freezes the split
      setThisPay(b, p.start, 'spare', 25000);
      expect(depositFor(b, 'spare', p, today)).toBe(25000);
      resetPay(b, p.start, {});
      expect(depositFor(b, 'spare', p, today)).toBe(10000);
      expect(b.overrides?.[p.start]).toBeUndefined();
    });
  }

  it('an amount set before payday and frozen in with the split comes off it too', () => {
    const b = spareBudget();
    const p = pay(b);
    setThisPay(b, p.start, 'spare', 25000);
    planFor(b, p, '2026-11-25'); // payday has passed: the split is frozen with the $250 in it
    expect(b.splitSent?.[p.start]?.spare).toBe(25000);
    resetPay(b, p.start, {});
    expect(depositFor(b, 'spare', p, '2026-11-25')).toBe(10000);
    // A change by hand: the morning's saved copy of the split isn't put back over it (state/store.tsx).
    expect(b.flags).toContain(morningFlag(p.start));
  });

  it('puts back the payday amounts balancing changed', () => {
    const b = spareBudget();
    b.split.find((l) => l.accountId === 'spare')!.mode = 'smooth';
    resetPay(b, pay(b).start, { spare: 'fixed' });
    expect(b.split.find((l) => l.accountId === 'spare')!.mode).toBe('fixed');
  });
});

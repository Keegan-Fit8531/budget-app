import { describe, expect, it } from 'vitest';
import { heldGemBudget } from '../testing/fixtures';
import { periodContaining } from './periods';
import { planFor, sendsTotal, splitShown } from './plan';

const today = '2026-11-10';

describe('a debt held in another account (Gem in Misc bills)', () => {
  it('is counted once: shown as its own amount and taken out of the account holding it', () => {
    const b = heldGemBudget();
    const plan = planFor(b, periodContaining('2026-11-20', b.settings), today);
    const funded = (id: string) => plan.accounts.find((a) => a.account.id === id)!.funded;
    expect(funded('gem')).toBeGreaterThan(0);
    expect(funded('bills')).toBeGreaterThanOrEqual(funded('gem') + 10000); // the bill and the held payment

    const shown = splitShown(b, plan.accounts, (a) => a.funded);
    expect(shown.get('gem')).toBe(funded('gem'));
    expect(shown.get('bills')).toBe(funded('bills') - funded('gem'));
    expect(shown.has(b.settings.payAccountId)).toBe(false);

    // Adding up the shown parts or the sends gives the pay's total, never Gem twice.
    expect(sendsTotal(b, plan.accounts, (a) => a.funded)).toBe(plan.totalSplit);
    expect([...shown.values()].reduce((t, x) => t + x, 0)).toBe(plan.totalSplit);
  });
});

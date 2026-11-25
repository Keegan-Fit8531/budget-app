import { describe, expect, it } from 'vitest';
import { endHeld, heldNow, resumeHeld } from './held';
import { billTxns, billsBudget } from '../../../../testing/fixtures';
import { billChecks } from '../../../accounts/logic/billCheck';
import type { Budget } from '../../../../core/types';

const { out } = billTxns;

/** Misc bills holds Gem Visa's 21 Nov payment and paid $30 of it on 22 Nov. */
function partPaid(): Budget {
  const b = billsBudget([], { bills: [out('2026-11-22', 3000, 'Gem Visa Fitzgerald K 000000601073')] });
  b.accounts.push({ id: 'gem', name: 'Gem Visa', kind: 'external', color: '#000', groupId: 'debt' });
  b.split.push({ accountId: 'gem', amount: 0, mode: 'exact' });
  b.debts = [{
    id: 'gem', name: 'Gem Visa', kind: 'card', rules: 'gem', accountId: 'gem', holdAccountId: 'bills', statementDay: 21,
    plans: [{ id: 'p1', name: 'TV', type: 'interest-free', original: 100000, remaining: 50400, asOf: '2026-10-01', purchaseDate: '2026-10-01', months: 6 }],
    balance: { amount: 50400, asOf: '2026-11-18' },
  }];
  return b;
}

describe('a held payment this month', () => {
  it('shows what was paid and what is still to send; "No more this month" ends it, and Undo brings it back', () => {
    const b = partPaid();
    const h = heldNow(b, b.debts![0], '2026-11-22')!;
    expect(h).toMatchObject({ date: '2026-11-21', accountId: 'bills', paid: 3000, ended: false });
    expect(h.toCome).toBeGreaterThan(0);

    let d = structuredClone(b);
    endHeld(d, 'gem', h, '2026-11-22');
    d = structuredClone(d);
    expect(heldNow(d, d.debts![0], '2026-11-22')).toMatchObject({ paid: 3000, toCome: 0, ended: true });
    expect(billChecks(d, '2026-11-22')).toEqual([]); // the bill check doesn't ask about the rest

    resumeHeld(d, 'gem', '2026-11-21');
    d = structuredClone(d);
    expect(heldNow(d, d.debts![0], '2026-11-22')).toEqual(h);
  });
});

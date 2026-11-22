import { describe, expect, it } from 'vitest';
import { billChecks } from './billCheck';
import { billTracker } from '../../../engine/balances/billTracker';
import { billTxns, billsBudget as bills } from '../../../testing/fixtures';
import type { Budget } from '../../../core/types';

const { out, toWeekly } = billTxns;

/** Misc bills holding Gem Visa's statement-day payment, with $200 paid to Gem from Weekly allowance the day before. */
function gemHeld(): Budget {
  const b = bills([], { weekly: [out('2026-11-20', 20000, 'Gem Visa Fitzgerald K 000000601073')] });
  b.accounts.push({ id: 'gem', name: 'Gem Visa', kind: 'external', color: '#000', groupId: 'debt' });
  b.split.push({ accountId: 'gem', amount: 0, mode: 'exact' });
  b.debts = [{
    id: 'gem', name: 'Gem Visa', kind: 'card', rules: 'gem', accountId: 'gem', holdAccountId: 'bills', statementDay: 21,
    plans: [{ id: 'p1', name: 'TV', type: 'interest-free', original: 100000, remaining: 50400, asOf: '2026-10-01', purchaseDate: '2026-10-01', months: 6 }],
    balance: { amount: 50400, asOf: '2026-11-18' },
  }];
  return b;
}

describe('bill check', () => {
  const skinny = (d: string) => out(d, 8300, 'Skinny Fixed Card number: 4835');

  it('a bill that keeps coming out two days later: suggest its real day', () => {
    // Set for the 17th; the bank shows the 19th (21 Sep: the 19th was a Saturday).
    const b = bills([{ name: 'Internet (Skinny)', amount: 8300, start: '2026-01-17' }],
      { weekly: [skinny('2026-09-21'), skinny('2026-10-19'), skinny('2026-11-19')], bills: [toWeekly('2026-09-20', 8300), toWeekly('2026-10-18', 8300), toWeekly('2026-11-18', 8300)] });
    const day = billChecks(b, '2026-11-22').find((c) => c.kind === 'day')!;
    expect(day.title).toBe('Internet (Skinny) comes out on the 19th');
    expect(day.detail).toContain('after payday on 18 Dec');
    // The store changes a copy (and the matching is cached per budget object).
    const changed = structuredClone(b);
    day.apply!.run(changed);
    expect(changed.items[0].start).toBe('2026-01-19');
    expect(billChecks(changed, '2026-11-22').some((c) => c.kind === 'day')).toBe(false);
  });

  it('a bill whose amount changed: suggest the new amount, and not again once you say no', () => {
    const b = bills([{ name: 'Mobile', amount: 20474, start: '2026-01-05' }],
      { bills: [out('2026-10-05', 20671, 'Spark Pay Mo'), out('2026-11-05', 20671, 'Spark Pay Mo')] });
    const amount = billChecks(b, '2026-11-22').find((c) => c.kind === 'amount')!;
    expect(amount.title).toBe('Mobile is now $206.71');
    b.billChecks = { [amount.key]: '2026-11-22' };
    expect(billChecks(b, '2026-11-22').some((c) => c.kind === 'amount')).toBe(false);
  });

  it("a bill not seen 3 days after it was due: ask if it's been paid", () => {
    const b = bills([{ name: 'Canva', amount: 2000, start: '2026-01-19' }], {});
    const late = billChecks(b, '2026-11-22');
    expect(late.map((c) => c.kind)).toEqual(['late']);
    expect(late[0].key).toBe('paid|i0|2026-11-19');
  });

  it('a bill on another card not made up yet: ask to move the money', () => {
    const b = bills([{ name: 'Netflix', amount: 1800, start: '2026-01-20' }], { weekly: [out('2026-11-21', 5397, 'Netflix New Card number: 4835')] });
    expect(billChecks(b, '2026-11-22').map((c) => c.title)).toEqual(['Move $18 to Weekly allowance']);
  });

  it('a held debt payment the bank shows paid from another account: ask if that was it', () => {
    const b = gemHeld();
    const gem = () => billTracker(b, 'bills', '2026-11-22').rows.filter((r) => r.debtId === 'gem');
    expect(gem().length).toBeGreaterThan(0);
    expect(gem().every((r) => r.status === 'paid')).toBe(true);
    const held = billChecks(b, '2026-11-22').find((c) => c.kind === 'held')!;
    expect(held.title).toMatch(/^Did Weekly allowance pay Gem Visa's \$/);
    expect(held.key).toBe('held|gem|2026-11-21');

    // "Yes, that paid it": its money is still in Misc bills, so suggest moving it back.
    const yes = structuredClone(b);
    yes.billChecks = { [held.key]: '2026-11-22' };
    expect(billChecks(yes, '2026-11-22').map((c) => c.kind)).toEqual(['move']);
    expect(billTracker(yes, 'bills', '2026-11-22').toMove.length).toBe(gem().length);

    // "Still to send from Misc bills": it's to come again, and isn't asked again.
    const still = structuredClone(b);
    held.apply!.run(still);
    still.billChecks![held.key] = '2026-11-22';
    const rows = billTracker(still, 'bills', '2026-11-22').rows.filter((r) => r.debtId === 'gem');
    expect(rows.every((r) => r.status === 'due' && r.late)).toBe(true);
    expect(billChecks(still, '2026-11-22')).toEqual([]);
  });

  it('no suggestions for accounts the bank connection does not fill', () => {
    const b = bills([{ name: 'Canva', amount: 2000, start: '2026-01-20' }], {});
    b.bankLinks = {};
    expect(billChecks(b, '2026-11-22')).toEqual([]);
    expect(billTracker(b, 'bills', '2026-11-22').rows.find((r) => r.name === 'Canva')!.status).toBe('paid');
  });
});

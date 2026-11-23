import { describe, expect, it } from 'vitest';
import { answeredChecks, billChecks } from './billCheck';
import { billTracker } from '../../../engine/balances/billTracker';
import { billTxns, billsBudget as bills } from '../../../testing/fixtures';
import type { Budget } from '../../../core/types';

const { out, toWeekly } = billTxns;

/** Misc bills holding Gem Visa's statement-day payment, with $200 paid to Gem from Weekly allowance the day before (or `txns`). */
function gemHeld(txns: Parameters<typeof bills>[1] = { weekly: [out('2026-11-20', 20000, 'Gem Visa Fitzgerald K 000000601073')] }): Budget {
  const b = bills([], txns);
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

  it('a new bill set to start on a day the bank already showed it on another: move it', () => {
    // Set to start on 10 Dec, but it came out on the 20th, on the Weekly allowance card, in October and November.
    const canv = (d: string) => out(d, 1500, 'Paypal *Canv Card number: 4835');
    const b = bills([{ name: 'Canva', amount: 1500, start: '2026-12-10' }],
      { weekly: [canv('2026-10-20'), canv('2026-11-20')], bills: [toWeekly('2026-11-21', 1500)] });
    const day = billChecks(b, '2026-11-22').find((c) => c.kind === 'day')!;
    expect(day.title).toBe('Canva comes out on the 20th');
    expect(day.detail).toContain('next one would be 20 Dec, so the next pay covers it');
    const changed = structuredClone(b);
    day.apply!.run(changed);
    expect(changed.items[0].start).toBe('2026-12-20');
    expect(billChecks(changed, '2026-11-22').some((c) => c.kind === 'day')).toBe(false);
    // Already on its day (or not seen): nothing to ask.
    expect(billChecks(bills([{ name: 'Canva', amount: 1500, start: '2026-12-20' }], { weekly: [canv('2026-11-20')] }), '2026-11-22').some((c) => c.kind === 'day')).toBe(false);
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
    expect(held.title).toMatch(/^Was Gem Visa's \$[\d.,]+ paid from Weekly allowance\?$/);
    expect(held.asks!.map((a) => a.label)).toEqual(['No, Misc bills paid it', 'No, Misc bills will pay it']);
    expect(held.key).toBe('held|gem|2026-11-21');

    // "Yes, that paid it": its money is still in Misc bills, so suggest moving it back.
    const yes = structuredClone(b);
    yes.billChecks = { [held.key]: '2026-11-22' };
    expect(billChecks(yes, '2026-11-22').map((c) => c.kind)).toEqual(['move']);
    expect(billTracker(yes, 'bills', '2026-11-22').toMove.length).toBe(gem().length);

    // "No, Misc bills will pay it": it's to come again, and isn't asked again.
    const still = structuredClone(b);
    held.asks![1].run(still, held.asks![1].initial);
    still.billChecks![held.key] = '2026-11-22';
    const rows = billTracker(still, 'bills', '2026-11-22').rows.filter((r) => r.debtId === 'gem');
    expect(rows.every((r) => r.status === 'due' && r.late)).toBe(true);
    expect(billChecks(still, '2026-11-22')).toEqual([]);
  });

  it('still to send, for a different amount, and undone', () => {
    const b = gemHeld();
    const held = billChecks(b, '2026-11-22').find((c) => c.kind === 'held')!;
    let d = structuredClone(b);
    held.asks![1].run(d, 15000);
    d.billChecks![held.key] = '2026-11-22';
    d = structuredClone(d);
    const rows = billTracker(d, 'bills', '2026-11-22').rows.filter((r) => r.debtId === 'gem');
    expect(rows.map((r) => [r.amount, r.status])).toEqual([[15000, 'due']]);
    const answers = answeredChecks(d, '2026-11-22');
    expect(answers.map((a) => a.title)).toEqual(['Gem Visa 21 Nov: still to send from Misc bills ($150)']);

    // Undo: back as it was, and the question is asked again.
    answers[0].undo(d);
    d = structuredClone(d);
    expect(d.debts![0].heldPay).toBeUndefined();
    expect(billChecks(d, '2026-11-22').map((c) => c.kind)).toEqual(['held']);
    expect(answeredChecks(d, '2026-11-22')).toEqual([]);
  });

  it("already paid from Misc bills (the bank doesn't show it yet): counted as paid, for that amount", () => {
    const b = gemHeld();
    const held = billChecks(b, '2026-11-22').find((c) => c.kind === 'held')!;
    let d = structuredClone(b);
    held.asks![0].run(d, 6000);
    d.billChecks![held.key] = '2026-11-22';
    d = structuredClone(d);
    const rows = billTracker(d, 'bills', '2026-11-22').rows.filter((r) => r.debtId === 'gem');
    expect(rows.map((r) => [r.amount, r.status])).toEqual([[6000, 'paid']]);
    expect(billChecks(d, '2026-11-22')).toEqual([]);
    expect(answeredChecks(d, '2026-11-22').map((a) => a.title)).toEqual(['Gem Visa 21 Nov: paid from Misc bills ($60)']);
  });

  it('Misc bills paid part of it: only that is paid, and it asks about the rest', () => {
    const b = gemHeld({ bills: [out('2026-11-22', 3000, 'Gem Visa Fitzgerald K 000000601073')] });
    const kept = billTracker(b, 'bills', '2026-11-20').rows.filter((r) => r.debtId === 'gem').reduce((t, r) => t + r.amount, 0);
    expect(kept).toBeGreaterThan(3000 * 1.2);
    const gem = (x: Budget) => billTracker(x, 'bills', '2026-11-22').rows.filter((r) => r.debtId === 'gem').map((r) => [r.amount, r.status]);
    expect(gem(b)).toEqual([[3000, 'paid'], [kept - 3000, 'due']]);
    const rest = billChecks(b, '2026-11-22').find((c) => c.key === 'rest|gem|2026-11-21')!;
    expect(rest.title).toBe("Is the rest of Gem Visa's payment still to send?");

    // "No, $30 was all": that's the whole payment.
    let all = structuredClone(b);
    rest.apply!.run(all);
    all.billChecks = { [rest.key]: '2026-11-22' };
    all = structuredClone(all);
    expect(gem(all)).toEqual([[3000, 'paid']]);
    expect(billChecks(all, '2026-11-22')).toEqual([]);

    // "Yes, more to send": $20 more, still to come.
    let more = structuredClone(b);
    rest.asks![0].run(more, 2000);
    more.billChecks = { [rest.key]: '2026-11-22' };
    more = structuredClone(more);
    expect(gem(more)).toEqual([[3000, 'paid'], [2000, 'due']]);
    expect(billChecks(more, '2026-11-22')).toEqual([]);
    // Undo: asked again, as it was.
    answeredChecks(more, '2026-11-22')[0].undo(more);
    more = structuredClone(more);
    expect(gem(more)).toEqual(gem(b));
  });

  it('no suggestions for accounts the bank connection does not fill', () => {
    const b = bills([{ name: 'Canva', amount: 2000, start: '2026-01-20' }], {});
    b.bankLinks = {};
    expect(billChecks(b, '2026-11-22')).toEqual([]);
    expect(billTracker(b, 'bills', '2026-11-22').rows.find((r) => r.name === 'Canva')!.status).toBe('paid');
  });
});

import { describe, expect, it } from 'vitest';
import { billChecks } from './billCheck';
import { billTracker } from '../../../engine/balances/billTracker';
import { billTxns, billsBudget as bills } from '../../../testing/fixtures';

const { out, toWeekly } = billTxns;

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

  it('no suggestions for accounts the bank connection does not fill', () => {
    const b = bills([{ name: 'Canva', amount: 2000, start: '2026-01-20' }], {});
    b.bankLinks = {};
    expect(billChecks(b, '2026-11-22')).toEqual([]);
    expect(billTracker(b, 'bills', '2026-11-22').rows.find((r) => r.name === 'Canva')!.status).toBe('paid');
  });
});

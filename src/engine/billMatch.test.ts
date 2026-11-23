import { describe, expect, it } from 'vitest';
import { matchBills, nameMatch, otherMoves } from './billMatch';
import { billTracker } from './balances/billTracker';
import { billTxns, billsBudget } from '../testing/fixtures';

const { out, toWeekly, fromWeekly } = billTxns;
const bills = billsBudget;

describe('names the bank uses for a bill', () => {
  it('matches typos, cut-off names and known payees', () => {
    expect(nameMatch('Circut', { description: 'Cricut Card number: 4835' })).toBe(2);
    expect(nameMatch('Kindergarten', { description: 'Epsom Kindergardten Mia F' })).toBe(2);
    expect(nameMatch('Canva', { description: 'Paypal *Canv Card number: 4835' })).toBe(2);
    expect(nameMatch('Netflix', { description: 'Paypal *Canv Card number: 4835' })).toBe(0);
    expect(nameMatch('YouTube', { description: 'Google Youtu Card number' })).toBe(2);
    expect(nameMatch('Mobile', { description: 'Spark Pay Mo Card number' })).toBe(1);
    expect(nameMatch('iCloud storage', { description: 'Apple.Com/Bi Card number' })).toBe(1);
    expect(nameMatch('Car insurance', { description: 'Tower Insurance 8208' })).toBe(0);
  });
});

describe('matching bills to the bank', () => {
  it('one payment for two bills on a day (car + contents insurance)', () => {
    const b = bills([{ name: 'Car insurance', amount: 11682, start: '2026-01-22' }, { name: 'Contents insurance', amount: 4899, start: '2026-01-22' }],
      { bills: [out('2026-11-22', 16581, 'Tower Insurance 820883506')] });
    const m = matchBills(b, 'bills', '2026-11-19', '2026-12-18', '2026-11-22');
    expect(m.filter((x) => x.how === 'direct' && x.shared)).toHaveLength(2);
  });

  it('a bill on the Weekly card, made up by a transfer the day before: paid, nothing to move', () => {
    const b = bills([{ name: 'Internet (Skinny)', amount: 8300, start: '2026-01-20' }],
      { bills: [toWeekly('2026-11-19', 8300)], weekly: [out('2026-11-20', 8300, 'Skinny Fixed Card number: 4835')] });
    const t = billTracker(b, 'bills', '2026-11-22');
    const row = t.rows.find((r) => r.name === 'Internet (Skinny)')!;
    expect(row.status).toBe('paid');
    expect(row.match).toMatchObject({ how: 'card', from: 'weekly' });
    expect(row.match?.cover?.date).toBe('2026-11-19');
    expect(t.toMove).toEqual([]);
    expect(t.moves).toEqual([]);
  });

  it('a bill on the Weekly card not made up yet: its money is to move, not spare', () => {
    const b = bills([{ name: 'Netflix', amount: 1800, start: '2026-01-20' }],
      { weekly: [out('2026-11-21', 5397, 'Netflix New Card number: 4835')] }, 30000);
    const t = billTracker(b, 'bills', '2026-11-22');
    expect(t.toMove).toMatchObject([{ to: 'weekly', amount: 1800 }]);
    expect(t.spare).toBe(30000 - 1800);
    // "No need to move it" keeps the money here as spare.
    b.billChecks = { 'move|i0|2026-11-20': '2026-11-22' };
    expect(billTracker(structuredClone(b), 'bills', '2026-11-22').spare).toBe(30000);
  });

  it('money moved across for a bill before its card charge shows: paid', () => {
    const b = bills([{ name: 'Internet (Skinny)', amount: 8300, start: '2026-01-23' }], { bills: [toWeekly('2026-11-22', 8300)] });
    const row = billTracker(b, 'bills', '2026-11-22').rows.find((r) => r.name === 'Internet (Skinny)')!;
    expect(row.status).toBe('paid');
    expect(row.match).toMatchObject({ how: 'moved', from: 'weekly' });
  });

  it("a bill the bank hasn't shown is still to come (its money is still there)", () => {
    const b = bills([{ name: 'Canva', amount: 2000, start: '2026-01-19' }], {});
    const t = billTracker(b, 'bills', '2026-11-22');
    const row = t.rows.find((r) => r.name === 'Canva')!;
    expect(row).toMatchObject({ status: 'due', late: true });
    expect(t.spare).toBe(50000 - 2000);
    // "It's been paid" counts it as paid.
    b.billChecks = { 'paid|i0|2026-11-19': '2026-11-22' };
    expect(billTracker(structuredClone(b), 'bills', '2026-11-22').rows.find((r) => r.name === 'Canva')!.status).toBe('paid');
  });

  it('money you moved in yourself is listed, payday is not', () => {
    const b = bills([], { bills: [
      fromWeekly('2026-11-19', 50000),
      { ...fromWeekly('2026-11-19', 15000), description: 'From: 06-0000-0000001-00 Credit Transfer 5678' },
    ] });
    const moves = otherMoves(b, 'bills', '2026-11-19', '2026-12-17', '2026-11-19', 50000, '2026-11-22');
    expect(moves.map((m) => [m.txn.amount, m.other?.id])).toEqual([[15000, 'weekly']]);
  });
});

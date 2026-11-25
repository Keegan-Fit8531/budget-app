import { describe, expect, it } from 'vitest';
import { bufferLine, potBuffer, runningLow } from './buffer';
import { billTracker } from './billTracker';
import { periodContaining } from '../periods';
import { budget } from '../../testing/fixtures';
import type { Item } from '../../core/types';

const TODAY = '2026-11-25';

/** Rent paid from a monthly pay (the 19th): $415 every Friday, $1,804.51 sent each payday, $1,619.51 in it today. */
function rentBudget(items: Item[] = [{ id: 'rent', name: 'Rent', amount: 41500, frequency: 'weekly', start: '2026-11-20', accountId: 'rent' }]) {
  const b = budget();
  b.accounts.push({ id: 'rent', name: 'Rent', kind: 'bank', color: '#000', groupId: 'needs' });
  b.split.push({ accountId: 'rent', amount: 180451, mode: 'fixed' });
  b.items.push(...items);
  b.balances = { rent: { amount: 161951, asOf: TODAY } };
  return b;
}
const thisPay = (b: ReturnType<typeof budget>) => periodContaining(TODAY, b.settings);

describe('runningLow: the lowest the running balance falls below zero', () => {
  it('needs about nothing for a 5-payment pay after two 4-payment pays', () => {
    expect(runningLow([14451, 14451, -27049])).toEqual({ buffer: 0, at: -1 });
  });
  it('needs more for two 5-payment pays close together', () => {
    expect(runningLow([-27049, -27049, 14451]).buffer).toBe(54098);
    expect(runningLow([-27049, 14451, -27049]).buffer).toBe(39647);
    expect(runningLow([-27049, 14451, -27049]).at).toBe(2);
  });
  it('is 0 with nothing due', () => {
    expect(runningLow([]).buffer).toBe(0);
    expect(runningLow([0, 0]).buffer).toBe(0);
  });
});

describe('potBuffer', () => {
  it('the real Rent case: $374.51 left before 18 Dec, $270.49 held for the 18 Dec pay, $104.02 free', () => {
    const b = rentBudget();
    const t = billTracker(b, 'rent', TODAY);
    expect(t.rows.filter((r) => r.status !== 'paid').map((r) => r.date)).toEqual(['2026-11-27', '2026-12-04', '2026-12-11']);
    expect(t.spare).toBe(37451);
    // The 18 Dec pay has 5 Fridays, the two after it 4.
    const x = potBuffer(b, 'rent', thisPay(b), t.spare, 3, TODAY);
    expect(x.run.map((r) => [r.period.start, r.need])).toEqual([['2026-12-18', 207500], ['2027-01-19', 166000], ['2027-02-19', 166000]]);
    expect(x).toMatchObject({ left: 37451, buffer: 27049, free: 10402 });
    expect(x.lowest).toMatchObject({ pays: 1, need: 207500, deposit: 180451 });
    expect(bufferLine(x)).toBe('$374.51 left after bills before 18 Dec · $270.49 held for the 18 Dec pay (needs $2,075, gets $1,804.51) · $104.02 free');
  });

  it('over 13 pays, names a later pay when the running balance is lowest there', () => {
    const b = rentBudget();
    const x = potBuffer(b, 'rent', thisPay(b), 37451, 13, TODAY);
    expect(x.lowest!.pays).toBeGreaterThan(1);
    expect(x.buffer).toBe(x.lowest!.need - x.lowest!.deposit);
    expect(bufferLine(x)).toContain(`held for the ${x.lowest!.period.start.slice(8, 10).replace(/^0/, '')} `);
    expect(bufferLine(x)).toContain(`the ${x.lowest!.pays} pays to then need`);
  });

  it('never shows money as free when the pot can’t cover its bills', () => {
    const b = rentBudget();
    const x = potBuffer(b, 'rent', thisPay(b), 10000, 3, TODAY);
    expect(x.free).toBe(10000 - 27049);
    expect(bufferLine(x)).toBe('$100 left after bills before 18 Dec · $270.49 needed for the 18 Dec pay (needs $2,075, gets $1,804.51) · $170.49 short');
    expect(bufferLine(x)).not.toContain('free');
  });

  it('uses what each pay will send: a bigger deposit for the 5-Friday pay needs no buffer', () => {
    const b = rentBudget();
    b.overrides = { '2026-12-18': { rent: 207500 } };
    expect(potBuffer(b, 'rent', thisPay(b), 37451, 3, TODAY).buffer).toBe(0);
  });

  it('is 0 for a pot with no recurring bills', () => {
    const b = rentBudget([]);
    const x = potBuffer(b, 'rent', thisPay(b), 50000, 13, TODAY);
    expect(x).toMatchObject({ buffer: 0, free: 50000 });
    expect(x.lowest).toBeUndefined();
  });

  it('counts fortnightly, monthly and one-off bills in the pay they fall in', () => {
    const b = rentBudget([
      { id: 'f', name: 'Fortnightly', amount: 10000, frequency: 'fortnightly', start: '2026-11-20', accountId: 'rent' },
      { id: 'm', name: 'Monthly', amount: 50000, frequency: 'monthly', start: '2026-12-01', accountId: 'rent' },
      { id: 'o', name: 'One-off', amount: 300000, frequency: 'once', start: '2027-01-25', accountId: 'rent' },
    ]);
    const x = potBuffer(b, 'rent', thisPay(b), 0, 3, TODAY);
    // 18 Dec pay: fortnightly 18 Dec, 1 Jan, 15 Jan + monthly 1 Jan. 19 Jan pay: 29 Jan, 12 Feb + 1 Feb + the one-off.
    expect(x.run.map((r) => r.need)).toEqual([80000, 370000, 70000]);
    expect(x.buffer).toBe(80000 + 370000 - 2 * 180451);
  });

  it('puts a bill on payday in the new pay, and one the day before in the old pay', () => {
    const b = rentBudget([
      { id: 'a', name: 'On payday', amount: 100000, frequency: 'once', start: '2027-01-19', accountId: 'rent' },
      { id: 'c', name: 'Day before', amount: 300000, frequency: 'once', start: '2027-01-18', accountId: 'rent' },
    ]);
    const x = potBuffer(b, 'rent', thisPay(b), 0, 2, TODAY);
    expect(x.run.map((r) => [r.period.start, r.need])).toEqual([['2026-12-18', 300000], ['2027-01-19', 100000]]);
  });
});

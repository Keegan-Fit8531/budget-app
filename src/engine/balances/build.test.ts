import { describe, expect, it } from 'vitest';
import { buildAt } from './build';
import { depositFor } from './deposits';
import { balanceOn } from './estimate';
import { periodContaining, shiftPeriod } from '../periods';
import { budget } from '../../testing/fixtures';

const TODAY = '2026-11-25';

/** Rent $400 every Friday, paid on the 19th, in Build up mode; $1,200 in it today = the three Fridays left this pay. */
function rentBudget() {
  const b = budget();
  b.accounts.push({ id: 'rent', name: 'Rent', kind: 'bank', color: '#000', groupId: 'needs' });
  b.split.push({ accountId: 'rent', amount: 0, mode: 'build' });
  b.items.push({ id: 'rent', name: 'Rent', amount: 40000, frequency: 'weekly', start: '2026-11-20', accountId: 'rent' });
  b.balances = { rent: { amount: 120000, asOf: TODAY } };
  return b;
}

describe('buildAt: one payday', () => {
  const avg = 173333; // $400 × 52 ÷ 12
  it('shares the stretch up to the bigger pay evenly, rounded', () => {
    expect(buildAt([160000, 160000, 200000], 0, avg, 1000)).toBe(173000); // $5,200 ÷ 3
    expect(buildAt([160000, 200000], 13000, avg, 1000)).toBe(174000); // ($3,600 − $130) ÷ 2 = $1,735
  });
  it('sends exactly what’s left on the bigger pay, so it ends at $0', () => {
    expect(buildAt([200000, 160000], 27000, avg, 1000)).toBe(173000);
  });
  it('sends more next payday when money was moved out', () => {
    expect(buildAt([200000], 27000 - 1387, avg, 1000)).toBe(174387);
  });
  it('never sends less than this pay’s own bills, or below $0', () => {
    expect(buildAt([160000, 160000, 200000], 600000, avg, 1000)).toBe(0); // more than the stretch needs is already there
    expect(buildAt([170000, 10000, 200000], 0, avg, 1000)).toBe(170000); // an even share would be $1,270
  });
  it('with no bigger pay ahead, just this pay’s bills less what’s there', () => {
    expect(buildAt([50000, 50000], 10000, 50000, 1000)).toBe(40000);
  });
});

describe('Build up mode pay by pay', () => {
  it('builds up in the 4-Friday pays and is back to $0 after each 5-Friday one', () => {
    const b = rentBudget();
    let p = periodContaining(TODAY, b.settings);
    const rows: [string, number, number][] = [];
    for (let i = 0; i < 4; i++) {
      p = shiftPeriod(p, 1, b.settings);
      rows.push([p.start, depositFor(b, 'rent', p, TODAY), balanceOn(b, 'rent', p.end, TODAY)!]);
    }
    expect(rows).toEqual([
      ['2026-12-18', 200000, 0], // 5 Fridays, nothing carried in
      ['2027-01-19', 173000, 13000], // ($1,600 + $1,600 + $2,000) ÷ 3
      ['2027-02-19', 174000, 27000], // ($3,600 − $130) ÷ 2 = $1,735 → $1,740
      ['2027-03-19', 173000, 0], // 5 Fridays: $2,000 − $270
    ]);
  });
});

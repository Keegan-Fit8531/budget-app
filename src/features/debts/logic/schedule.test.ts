import { describe, expect, it } from 'vitest';
import { depositFor } from '../../../engine/balances/deposits';
import { periodContaining, shiftPeriod } from '../../../engine/periods';
import { debtSchedules } from './schedule';
import { budget } from '../../../testing/fixtures';

describe('a paused plan (First payment)', () => {
  it('a regular payment paused until March sends nothing before then, then its amount each pay', () => {
    const b = budget();
    b.accounts.push({ id: 'k', name: 'Kim', kind: 'external', color: '#000', groupId: 'debt' });
    b.split.push({ accountId: 'k', amount: 0, mode: 'exact' });
    b.debts = [{
      id: 'k', name: 'Kim', kind: 'person', accountId: 'k',
      plans: [{ id: 'p', name: 'Scooter', type: 'balance', original: 100000, remaining: 100000, asOf: '2026-11-27', purchaseDate: '2026-11-27', payment: 20000, startsOn: '2027-03-01' }],
    }];
    const dates = debtSchedules(b.debts[0], b.settings).flatMap((x) => x.payments).map((p) => p.date);
    expect(dates[0] >= '2027-03-01').toBe(true);
    expect(dates).toHaveLength(5);
    let pay = periodContaining('2026-12-20', b.settings);
    const sends: number[] = [];
    for (let i = 0; i < 4; i++, pay = shiftPeriod(pay, 1, b.settings)) sends.push(depositFor(b, 'k', pay, '2026-11-27'));
    expect(sends).toEqual([0, 0, 0, 20000]);
  });
});

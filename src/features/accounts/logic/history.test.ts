import { describe, expect, it } from 'vitest';
import { balanceToday, estimateBalance } from '../../../engine/balances/estimate';
import { depositFor } from '../../../engine/balances/deposits';
import { periodContaining, shiftPeriod } from '../../../engine/periods';
import { accountHistory, recordCost, removeCost, setBalance } from './history';
import type { Budget } from '../../../core/types';
import { budget } from '../../../testing/fixtures';

describe("an account's history and one-off costs", () => {
  const today = '2026-11-16';
  function car(): Budget {
    const b = budget();
    b.accounts.push({ id: 'car', name: 'Car', kind: 'bank', color: '#000', groupId: 'needs' });
    b.split.push({ accountId: 'car', amount: 0, mode: 'exact' });
    b.items.push(
      { id: 'm', name: 'Motor maintenance', amount: 13000, frequency: 'monthly', start: '2026-11-01', accountId: 'car', setAside: true },
      { id: 'w', name: 'WOF', amount: 7000, frequency: 'monthly', start: '2026-11-01', accountId: 'car', setAside: true },
    );
    setBalance(b, 'car', 120000, '2026-11-14', 'b1');
    return b;
  }
  const next = (b: Budget) => shiftPeriod(periodContaining(today, b.settings), 1, b.settings);

  it('a one-off cost comes off what is in the account, and is kept in the history', () => {
    const b = car();
    expect(recordCost(b, 'car', { amount: 18000, date: '2026-11-16', note: 'Tyre puncture' }, 'c1')).toBe(true);
    expect(balanceToday(b, 'car', today)).toBe(102000);
    expect(accountHistory(b, 'car').map((e) => [e.kind, e.date, e.amount, e.note])).toEqual([
      ['cost', '2026-11-16', 18000, 'Tyre puncture'], ['balance', '2026-11-14', 120000, undefined],
    ]);
    // Paid from what's put aside: payday still puts aside $200, and the fund builds up again from $1,020.
    expect(depositFor(b, 'car', next(b), today)).toBe(20000);
    expect(estimateBalance(b, 'car', '2026-11-30', today)).toBe(102000 + 20000);
    // Nothing to take it from without a balance.
    const c = budget();
    expect(recordCost(c, 'everyday', { amount: 100, date: today, note: 'x' }, 'c')).toBe(false);
    expect(c.accountHistory).toBeUndefined();
  });

  it('from a bills account, next payday makes it up', () => {
    const b = budget();
    b.accounts.push({ id: 'bills', name: 'Bills', kind: 'bank', color: '#000', groupId: 'needs' });
    b.split.push({ accountId: 'bills', amount: 0, mode: 'exact' });
    b.items.push({ id: 'p', name: 'Power', amount: 20000, frequency: 'monthly', start: '2026-11-17', accountId: 'bills' });
    // $200 there now covers the 17 Nov power bill, so the next pay sends the 17 Dec one's $200.
    setBalance(b, 'bills', 20000, today, 'b1');
    expect(depositFor(b, 'bills', next(b), today)).toBe(20000);
    recordCost(b, 'bills', { amount: 5000, date: today, note: 'Late fee' }, 'c1');
    expect(depositFor(b, 'bills', next(b), today)).toBe(25000);
  });

  it('removing a cost can put its money back, or leave the balance as it is', () => {
    const b = car();
    recordCost(b, 'car', { amount: 18000, date: today, note: 'Tyre puncture' }, 'c1');
    recordCost(b, 'car', { amount: 9000, date: '2026-11-15', note: 'Wipers' }, 'c2');
    expect(balanceToday(b, 'car', today)).toBe(93000);
    // Recorded later but paid earlier: listed by the day it was paid.
    expect(accountHistory(b, 'car').map((e) => e.id)).toEqual(['c1', 'c2', 'b1']);
    removeCost(b, 'car', 'c1', true);
    expect(balanceToday(b, 'car', today)).toBe(111000);
    removeCost(b, 'car', 'c2', false);
    expect(balanceToday(b, 'car', today)).toBe(111000);
    expect(accountHistory(b, 'car').map((e) => e.id)).toEqual(['b1']);
    // A balance can't be removed this way.
    removeCost(b, 'car', 'b1', true);
    expect(accountHistory(b, 'car')).toHaveLength(1);
  });

  it('notes each balance you enter; entering it again straight away replaces the note', () => {
    const b = car();
    setBalance(b, 'car', 110000, '2026-11-14', 'b2');
    expect(accountHistory(b, 'car').map((e) => [e.id, e.amount])).toEqual([['b1', 110000]]);
    recordCost(b, 'car', { amount: 5000, date: '2026-11-14', note: 'Car wash' }, 'c1');
    setBalance(b, 'car', 104000, '2026-11-14', 'b3');
    expect(b.balances?.car).toEqual({ amount: 104000, asOf: '2026-11-14' });
    expect(accountHistory(b, 'car').map((e) => e.id)).toEqual(['b3', 'c1', 'b1']);
  });
});

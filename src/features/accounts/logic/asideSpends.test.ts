import { describe, expect, it } from 'vitest';
import { asideShopMatch, asideSpends, asideSpentSince, unsortedAsideSpends } from './asideSpends';
import { budget } from '../../../testing/fixtures';
import type { Budget, Txn } from '../../../core/types';

// A car fund like the real Car maintenance account: $150 a pay from Weekly allowance (where pay lands, and the
// card), put aside for rego and for maintenance. Payday is the 19th. All made up.
const WEEKLY = '06-0000-0000001-00', CAR = '06-0000-0000001-56', BILLS = '06-0000-0000001-54';
const tx = (date: string, amount: number, description: string): Txn => ({ date, amount, description });

function carFund(car: Txn[], weekly: Txn[] = []): Budget {
  const b = budget();
  b.accounts.push(
    { id: 'weekly', name: 'Weekly allowance', kind: 'bank', color: '#000', groupId: 'lifestyle', number: WEEKLY },
    { id: 'car', name: 'Car maintenance', kind: 'bank', color: '#000', groupId: 'needs', number: CAR },
    { id: 'bills', name: 'Misc bills', kind: 'bank', color: '#000', groupId: 'needs', number: BILLS },
  );
  b.settings.payAccountId = 'weekly';
  b.split.push({ accountId: 'car', amount: 15000, mode: 'fixed' });
  b.items.push(
    { id: 'rego', name: 'WOF / rego set-aside', amount: 5000, frequency: 'monthly', start: '2026-01-19', accountId: 'car', setAside: true },
    { id: 'fix', name: 'Motor maintenance set-aside', amount: 10000, frequency: 'monthly', start: '2026-01-19', accountId: 'car', setAside: true },
  );
  b.accountTransactions = { car, weekly };
  b.balances = { car: { amount: 0, asOf: '2026-11-24' } };
  return b;
}

const payday = tx('2026-11-19', 15000, `From: ${WEEKLY} Credit Transfer 1`);

describe('money spent from a put-aside account', () => {
  it('asks what a transfer out paid for, and finds the purchase it covered', () => {
    const b = carFund(
      [payday, tx('2026-11-23', -15000, `To: ${WEEKLY} Debit Transfer 2`)],
      [tx('2026-11-24', -1499, 'Paypal *Coin'), tx('2026-11-24', -14262, 'NZ Transport Agency Card number: 4835')],
    );
    const [ask, ...rest] = unsortedAsideSpends(b, 'car', '2026-11-24');
    expect(rest).toEqual([]);
    expect(ask.to?.name).toBe('Weekly allowance');
    expect(ask.paidFor?.txn.description).toContain('NZ Transport');
    // Rego first: NZ Transport is where rego is paid.
    expect(ask.likely.map((i) => i.id)).toEqual(['rego', 'fix']);
  });

  it("doesn't ask about money that came straight back, but payday's deposit isn't money coming back", () => {
    const b = carFund([
      payday,
      tx('2026-11-19', -5000, `To: ${BILLS} Debit Transfer 3`), tx('2026-11-20', 5000, `From: ${BILLS} Credit Transfer 4`),
      tx('2026-11-22', -15000, `To: ${WEEKLY} Debit Transfer 5`),
    ]);
    expect(unsortedAsideSpends(b, 'car', '2026-11-24').map((s) => s.txn.amount)).toEqual([-15000]);
  });

  it('keeps your answers: counted ones are the record, "not from it" ones stop being asked', () => {
    const out1 = tx('2026-11-23', -15000, `To: ${WEEKLY} Debit Transfer 2`);
    const out2 = tx('2026-11-21', -3000, `To: ${WEEKLY} Debit Transfer 6`);
    const old = tx('2026-03-02', -42000, 'Beaurepaires Ellerslie');
    const b = carFund([payday, out1, out2, old]);
    b.asideSpends = { [`car|${out1.amount}|${out1.description}`]: 'rego', [`car|${out2.amount}|${out2.description}`]: '', [`car|${old.amount}|${old.description}`]: 'fix' };
    expect(unsortedAsideSpends(b, 'car', '2026-11-24')).toEqual([]);
    const spent = asideSpends(b, 'car');
    expect(spent.map((s) => s.itemId)).toEqual(['rego', 'fix']);
    // A purchase straight from the account paid for itself.
    expect(spent[1].paidFor?.txn).toBe(old);
    expect([...asideSpentSince(spent, '2025-11-24')]).toEqual([['rego', 15000], ['fix', 42000]]);
    expect([...asideSpentSince(spent, '2026-06-01')]).toEqual([['rego', 15000]]);
  });

  it('tells rego shops from maintenance shops', () => {
    const rego = { name: 'WOF / rego set-aside' }, fix = { name: 'Motor maintenance set-aside' };
    expect(asideShopMatch(rego, { description: 'VTNZ Mt Wellington' })).toBe(true);
    expect(asideShopMatch(fix, { description: 'VTNZ Mt Wellington' })).toBe(false);
    expect(asideShopMatch(fix, { description: 'Repco Penrose' })).toBe(true);
    expect(asideShopMatch({ name: 'Tyres' }, { description: 'Tyres R Us' })).toBe(true);
  });
});

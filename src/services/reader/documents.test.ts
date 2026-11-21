import { describe, expect, it } from 'vitest';
import { classifyText, matchDebt, parseDate, parseStatementText, recordStatement } from './documents';
import type { Debt } from '../../core/types';
import { budget } from '../../testing/fixtures';

describe('reading a statement', () => {
  it('finds the balance, date, limit and minimum in a card statement', () => {
    const s = parseStatementText(`Gem Visa  Statement date: 21 Oct 2026
      Opening balance $1,902.11  Purchases $340.00  Payments -$500.00 CR
      Closing balance   $1,742.11   Credit limit $8,000.00  Available credit $6,257.89
      Minimum payment due $52.00 by 15 Nov 2026`);
    expect(s).toEqual({ balance: 174211, date: '2026-10-21', limit: 800000, available: 625789, minimum: 5200 });
  });

  it('reads other wordings, a balance in credit, and limit minus available', () => {
    expect(parseStatementText('Total amount owing: 2,340.50 as at 03/11/2026')).toMatchObject({ balance: 234050, date: '2026-11-03' });
    expect(parseStatementText('Current balance $12.40 CR').balance).toBe(0);
    expect(parseStatementText('Credit limit $5,000.00 Available to spend $4,100.00').balance).toBe(90000);
    expect(parseStatementText('A photo of a cat').balance).toBeUndefined();
  });

  it('reads dates day first', () => {
    expect([parseDate('21 October 2026'), parseDate('October 21, 2026'), parseDate('3/11/26'), parseDate('31-12-2026'), parseDate('soon')])
      .toEqual(['2026-10-21', '2026-10-21', '2026-11-03', '2026-12-31', undefined]);
  });

  it('tells a payslip from a statement, and picks the debt it names', () => {
    expect(classifyText('Pay Day: 19-Nov-2026 Total Payments $4,000.00').kind).toBe('payslip');
    expect(classifyText('Closing balance $10.00').kind).toBe('statement');
    const debts: Debt[] = [
      { id: 'a', name: 'Gem Visa', kind: 'card', rules: 'gem', accountId: 'a', plans: [] },
      { id: 'b', name: 'Q Mastercard', kind: 'card', rules: 'mastercard', accountId: 'b', plans: [] },
    ];
    expect(matchDebt(debts, 'Your Q Mastercard statement')?.id).toBe('b');
    expect(matchDebt(debts, 'GEM VISA closing balance')?.id).toBe('a');
    expect(matchDebt(debts, 'Power bill')).toBeUndefined();
  });

  it('sets what the debt owes as at the statement date', () => {
    const b = budget();
    b.debts = [{ id: 'a', name: 'Card', kind: 'card', accountId: 'a', limit: 500000, plans: [] }];
    recordStatement(b, 'a', { balance: 174211, date: '2026-11-10', limit: 800000 }, '2026-11-12');
    expect(b.debts[0]).toMatchObject({ balance: { amount: 174211, asOf: '2026-11-10' }, limit: 800000, history: [{ amount: 174211, asOf: '2026-11-10' }] });
    // A date in the future (misread) counts as today.
    recordStatement(b, 'a', { balance: 100000, date: '2027-01-01' }, '2026-11-12');
    expect(b.debts[0].balance).toEqual({ amount: 100000, asOf: '2026-11-12' });
  });
});

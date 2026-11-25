import { describe, expect, it } from 'vitest';
import { billsBudget } from '../../../testing/fixtures';
import { lastMonthFlow } from './moneyFlow';

describe('money in and out of the account pay lands in', () => {
  it("doesn't count money moved to your own accounts as spent", () => {
    // Pay lands in Weekly allowance; $100 of it goes on to Misc bills, $50 is spent at a shop, $20 comes back.
    const b = billsBudget([], {
      weekly: [
        { date: '2026-11-19', amount: 300000, description: 'ACME LTD SALARY' },
        { date: '2026-11-19', amount: -10000, description: 'To: 06-0000-0000001-54 Debit Transfer 1234' },
        { date: '2026-11-20', amount: -5000, description: 'COUNTDOWN GLEN EDEN' },
        { date: '2026-11-22', amount: 2000, description: 'From: 06-0000-0000001-54 Credit Transfer 1234' },
        { date: '2026-10-01', amount: -9900, description: 'MORE THAN 30 DAYS AGO' },
      ],
    });
    expect(lastMonthFlow(b, 'weekly', '2026-11-25')).toEqual({ spent: 5000, in: 302000 });
  });
});

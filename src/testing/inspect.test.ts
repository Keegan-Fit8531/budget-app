import { describe, expect, it } from 'vitest';
import { foodGasBudget } from './fixtures';
import { inspectAccount, inspectAll } from './inspect';

describe('inspect (npm run inspect)', () => {
  it('reports an account, its envelopes and the transfer the card asks about', () => {
    const b = foodGasBudget();
    b.pendingTransactions = { food: [{ date: '2026-11-22', description: 'To: 06-0115-0324910-00 Debit Transfer 1', amount: -5000 }] };
    const text = inspectAccount(b, 'food and', '2026-11-22').join('\n');
    expect(text).toContain('Food and gas (food, 06-0115-0324910-55)');
    expect(text).toContain('Food shop · week 19 Nov – 25 Nov · budget $200 · spent $0 · left $200 · 4 later weeks $800');
    expect(text).toContain('nothing nearby matches');
    expect(text).toContain('card asks which envelope');
    expect(inspectAccount(b, 'nope', '2026-11-22')[0]).toContain('No account matches');
    expect(inspectAll(b, '2026-11-22').some((l) => l.startsWith('Food and gas (food)'))).toBe(true);
  });

  it('names each envelope a transfer could be for, with the purchase that made it one', () => {
    const b = foodGasBudget();
    b.pendingTransactions = {
      food: [{ date: '2026-11-22', description: 'To: 06-0115-0324910-00 Debit Transfer 1', amount: -2000 }],
      day: [{ date: '2026-11-22', description: 'U-Go Epsom', amount: -2035 }, { date: '2026-11-22', description: 'Freshchoice', amount: -2119 }],
    };
    const text = inspectAccount(b, 'food and', '2026-11-22').join('\n');
    expect(text).toContain('could be Scooter gas (U-Go Epsom −$20.35 on 22 Nov) or Food shop (Freshchoice −$21.19 on 22 Nov)');
  });
});

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
});

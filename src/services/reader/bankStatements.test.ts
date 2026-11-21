import { describe, expect, it } from 'vitest';
import { csvTargets } from './check/transactions';
import { parseReply } from './gemini';
import type { Extraction } from './types';
import { endingOf, fromStatementRows } from '../bank/csv';
import { layoutPage } from './pdftext';
import { mergeReads, splitRow } from './gemini';
import { categorize } from '../../features/insights/logic/spending';
import { debtBudget, checkDoc } from '../../testing/fixtures';

describe('reading bank account statements', () => {
  it('a bank account statement comes back as the account’s transactions, not a card statement', () => {
    const reply = { candidates: [{ content: { parts: [{ text: JSON.stringify({
      kind: 'account', payslip: null, statement: null, afterpay: null, notes: null,
      account: { name: 'Go', number: '06-0999-0123456-00', closingBalance: { amount: '46.67', label: 'Balance' }, closingDate: '2026-06-15', rows: [
        { date: '2026-06-10', description: 'CREDIT TRANSFER', amount: '150.00', balance: '151.00' },
        { date: '2026-06-15', description: 'FRESHCHOICE', amount: '-4.49', balance: null },
      ] },
    }) }] } }] };
    const ex = parseReply(reply, '2026-11-16');
    expect(ex.kind).toBe('transactions');
    expect(ex.transactions).toEqual({ rows: [
      { date: '2026-06-10', description: 'CREDIT TRANSFER', amount: 15000, balance: 15100 },
      { date: '2026-06-15', description: 'FRESHCHOICE', amount: -449, balance: 4667 }, // the closing balance, on the last one
    ], ending: '3456', card: false, skipped: 0 });
  });

  it('a date that would be after today (a statement printed without years) is last year’s', () => {
    const r = fromStatementRows([{ date: '2026-12-20', description: 'Kmart', amount: '-10.00' }, { date: '2026-01-05', description: 'Pay', amount: '100.00' }, { description: 'Opening balance' }], { today: '2026-11-16' });
    expect(r.rows.map((t) => t.date)).toEqual(['2025-12-20', '2026-01-05']);
    expect(r.skipped).toBe(1);
    // An opening balance listed as if it were money in is left out.
    expect(fromStatementRows([{ date: '2025-12-11', description: 'Opening balance', amount: '35.50' }, { date: '2025-12-11', description: 'Balance brought forward from previous page', amount: '46.67' }], { today: '2026-11-16' }).rows).toEqual([]);
  });

  it('a long statement read a few pages at a time is put back together in order', () => {
    const part = (rows: [string, number][]): Extraction => ({ kind: 'transactions', transactions: { rows: rows.map(([date, amount]) => ({ date, description: 'x', amount })), card: false, skipped: 0 } });
    const all = mergeReads([part([['2026-01-02', -1], ['2026-01-03', -2]]), { kind: 'unknown' }, { ...part([['2026-01-03', -3], ['2026-01-09', 4]]), transactions: { rows: [{ date: '2026-01-03', description: 'x', amount: -3 }, { date: '2026-01-09', description: 'x', amount: 4 }], ending: '4910', card: false, skipped: 1 } }]);
    expect(all.kind).toBe('transactions');
    expect(all.transactions!.rows.map((t) => t.amount)).toEqual([-1, -2, -3, 4]);
    expect(all.transactions).toMatchObject({ ending: '4910', skipped: 1 });
    // A card statement over a few pages: its figures from the first, its plans from all.
    const st = mergeReads([
      { kind: 'statement', statement: { balance: { amount: '3084.17' }, statementDate: '2026-10-21', plans: [{ remaining: { amount: '1150.00' }, ends: '2027-01-20' }] } },
      { kind: 'statement', statement: { plans: [{ remaining: { amount: '870.00' }, ends: '2027-03-21' }] } },
    ]);
    expect(st.statement).toMatchObject({ balance: { amount: '3084.17' }, statementDate: '2026-10-21' });
    expect(st.statement!.plans).toHaveLength(2);
  });

  it('a page’s text keeps its columns, so withdrawals and deposits stay apart', () => {
    const text = layoutPage([
      { s: 'Date', x: 60, y: 700 }, { s: 'Withdrawals', x: 470, y: 700 }, { s: 'Deposits', x: 560, y: 700 },
      { s: '10 Jun', x: 60, y: 680 }, { s: 'PAY', x: 110, y: 680 }, { s: '150.00', x: 570, y: 680 },
      { s: '11 Jun', x: 60, y: 660 }, { s: 'KMART', x: 110, y: 660 }, { s: '8.49', x: 480, y: 660 },
    ]);
    const lines = text.split('\n');
    expect(lines[1].indexOf('150.00')).toBeGreaterThan(lines[0].indexOf('Deposits') - 3);
    expect(lines[2].indexOf('8.49')).toBeLessThan(lines[0].indexOf('Deposits'));
  });

  it('the account number is found in a statement’s file name; any account (not a card’s own) can be chosen', () => {
    expect(endingOf('06-0115-0123456-00_Statement_multiple.pdf')).toBe('3456');
    const b = debtBudget();
    b.accounts.push({ id: 'allowance', name: 'Allowance (other bank)', kind: 'external', color: '#000', groupId: 'lifestyle' });
    const targets = csvTargets(b).map((t) => t.value);
    expect(targets).toContain('account:allowance');
    expect(targets).toContain('account:everyday');
    expect(targets).not.toContain('account:gem'); // Gem's payment account: choose the card instead
    // Paying a card from the account isn't spending (it's counted on the card).
    expect(categorize('Q Mastercard Payment').category).toBe('transfers');
  });
});

describe('reading long bank statements quickly', () => {
  it('each transaction comes back as one line, split back into its parts', () => {
    expect(splitRow('2026-06-10|Pizza Hut Ho|-8.49|342.51')).toEqual({ date: '2026-06-10', description: 'Pizza Hut Ho', amount: '-8.49', balance: '342.51' });
    expect(splitRow('2026-06-10|Pizza Hut Ho|-8.49|')).toEqual({ date: '2026-06-10', description: 'Pizza Hut Ho', amount: '-8.49' });
    expect(splitRow('2026-06-10|A | B Ltd|-8.49|342.51').description).toBe('A | B Ltd');
  });

  it('the running balance puts right a sign read the wrong way round, and counts what doesn’t add up', () => {
    const r = fromStatementRows([
      { description: 'Opening balance', balance: '100.00' },
      { date: '2026-06-10', description: 'Pay', amount: '-50.00', balance: '150.00' }, // money in, read as out
      { date: '2026-06-11', description: 'Kmart', amount: '-20.00', balance: '130.00' },
      { date: '2026-06-12', description: 'Countdown', amount: '-10.00', balance: '100.00' }, // doesn't add up either way
    ], { today: '2026-11-16' });
    expect(r.rows.map((t) => t.amount)).toEqual([5000, -2000, -1000]);
    expect(r.unsure).toBe(1);
    const t = checkDoc(debtBudget(), { kind: 'transactions', transactions: r }, '2026-11-16', (d) => { d.transactions.target = 'account:everyday'; });
    expect(t.issues.map((i) => i.text).join(' ')).toMatch(/One transaction doesn’t add up/);
  });
});

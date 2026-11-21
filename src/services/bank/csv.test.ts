import { describe, expect, it } from 'vitest';
import { owed } from '../../features/debts/logic/amounts';
import { applyProposal } from '../reader/apply';
import { review } from '../reader/check/review';
import { toDraft } from '../reader/check/toDraft';
import type { Extraction } from '../reader/types';
import { csvAmount, csvDate, fromStatementRows, readTransactionsCsv } from './csv';
import { categorize, summarize } from '../../features/insights/logic/spending';
import { debtBudget, seq, checkDoc, upload, debt, qExport, csvDoc } from '../../testing/fixtures';

describe('reading bank and card exports', () => {
  it('reads a card export: newest first, quoted commas, $0 rows left out, the card number kept', () => {
    const r = readTransactionsCsv(qExport)!;
    expect(r).toMatchObject({ ending: '9999', card: true, skipped: 1 });
    expect(r.rows.map((t) => [t.date, t.amount])).toEqual([['2026-10-28', -3000], ['2026-11-02', -700], ['2026-11-10', -4000], ['2026-11-12', 10000], ['2026-11-15', -1250]]);
    expect(r.rows[2].description).toBe('SUPERCHEAP AUTO 7 Mth 0% Int, 7 Mth Pmt Hol');
  });

  it('reads a bank export with the account above the columns, a balance column, and separate money in and out', () => {
    const bank = readTransactionsCsv(['"Everyday Account","12-3456-0123456-00"', 'Date,Payee,Particulars,Code,Reference,Amount,Balance',
      '14/11/2026,Countdown Henderson,,,,-45.20,354.80', '15/11/2026,Transfer from savings,,,,100.00,454.80', '16/11/2026,McDonalds Albany,,,,-15.40,439.40'].join('\n'))!;
    expect(bank).toMatchObject({ ending: '3456', card: false });
    expect(bank.rows[2]).toMatchObject({ date: '2026-11-16', amount: -1540, balance: 43940 });
    const split = readTransactionsCsv('Date,Description,Debit,Credit\n01/11/2026,Countdown,12.50,\n02/11/2026,Pay,,500.00')!;
    expect(split.rows.map((t) => t.amount)).toEqual([-1250, 50000]);
    // A card export that writes spending as + and payments as −: turned round.
    const flipped = readTransactionsCsv('Transaction Date,Details,Amount\n2026-11-01,PAYMENT RECEIVED,-100.00\n2026-11-02,KMART,25.00')!;
    expect(flipped.rows.map((t) => t.amount)).toEqual([10000, -2500]);
    expect([csvDate('3 Nov 2026'), csvDate('03-Nov-26'), csvDate('31/02/2026'), csvAmount('(12.40)'), csvAmount('1,240.50 DR')]).toEqual(['2026-11-03', '2026-11-03', undefined, -1240, -124050]);
    expect(readTransactionsCsv('Name,Colour\nBob,blue')).toBeUndefined();
  });

  it('the first time, it asks which card it is: nothing is saved until you choose', () => {
    const r = checkDoc(debtBudget(), csvDoc(qExport), '2026-11-16');
    expect(r.proposal).toBeNull();
    expect(r.issues[0].text).toMatch(/Choose which card this is for/);
  });

  it('keeps the transactions on the card, works out what’s owed from the last checked balance, and fills in its history', () => {
    const b = debtBudget(); // the Q card: $500 checked on 1 Nov
    const r = upload(b, csvDoc(qExport), '2026-11-16', (d) => { d.transactions.target = 'debt:qcard'; });
    expect(r.proposal).toMatchObject({ kind: 'transactions', balance: { amount: 50000 + 700 + 4000 - 10000 + 1250, asOf: '2026-11-15' } });
    const q = debt(b, 'qcard');
    expect(q.transactions).toHaveLength(5);
    expect(q.ending).toBe('9999');
    expect(owed(q)).toBe(45950);
    expect(q.checked).toEqual({ amount: 45950, asOf: '2026-11-15' });
    // Before the $500 it knew of, worked back; after it, worked forward day by day.
    expect(q.history!.map((h) => [h.asOf, h.amount])).toEqual(expect.arrayContaining([['2026-10-28', 50000], ['2026-11-02', 50700], ['2026-11-10', 54700], ['2026-11-12', 44700], ['2026-11-15', 45950]]));

    // Next time it's matched by the card number (and shown, to check), and only what's new is added.
    const again = toDraft(csvDoc(`${qExport}\n16/11/26,9999,Countdown Glen Eden,-$20.00`), b, 'device', seq(), '2026-11-16');
    expect(again.transactions).toMatchObject({ target: 'debt:qcard', matchedBy: '9999' });
    const r2 = review(again, b, '2026-11-16');
    expect(r2.proposal).toMatchObject({ add: [{ date: '2026-11-16', amount: -2000 }], balance: { amount: 47950, asOf: '2026-11-16' } });
    expect(r2.ignored[0]).toMatch(/5 transactions already saved/);
    applyProposal(b, r2.proposal!, '2026-11-16');
    const r3 = checkDoc(b, csvDoc(qExport), '2026-11-16');
    expect(r3.proposal).toBeNull();
    expect(r3.issues.map((i) => i.text).join(' ')).toMatch(/Nothing new/);
  });

  it('what’s owed can be typed in instead, and isn’t guessed when there’s no checked balance to add to', () => {
    const b = debtBudget();
    debt(b, 'qcard').paid = [{ date: '2026-11-05', amount: 10000, name: 'Balance' }]; // payments were counted automatically
    const guessed = checkDoc(b, csvDoc(qExport), '2026-11-16', (d) => { d.transactions.target = 'debt:qcard'; });
    expect(guessed.proposal).toMatchObject({ kind: 'transactions' });
    expect((guessed.proposal as { balance?: unknown }).balance).toBeUndefined();
    expect(guessed.issues.map((i) => i.text).join(' ')).toMatch(/isn’t changed/);
    const typed = checkDoc(b, csvDoc(qExport), '2026-11-16', (d) => { d.transactions.target = 'debt:qcard'; d.transactions.amount = '612.40'; });
    expect(typed.proposal).toMatchObject({ balance: { amount: 61240, asOf: '2026-11-16' } });
  });

  it('a bank export goes on the account, with its balance from the export', () => {
    const b = debtBudget();
    const text = ['Date,Payee,Amount,Balance', '14/11/2026,Countdown Henderson,-45.20,354.80', '16/11/2026,McDonalds Albany,-15.40,339.40'].join('\n');
    upload(b, csvDoc(text), '2026-11-16', (d) => { d.transactions.target = 'account:everyday'; });
    expect(b.accountTransactions?.everyday).toHaveLength(2);
    expect(b.balances?.everyday).toEqual({ amount: 33940, asOf: '2026-11-16' });
  });

  it('puts purchases in categories by the shop, so Insights can show what adds up', () => {
    expect(categorize('McDonalds 123456 Queen St A NZL')).toEqual({ category: 'takeaways', shop: 'McDonald’s' });
    expect(categorize('MYLOTTO.CO.NZ NEW ZEALAND 5 Months No Payments No Interest').category).toBe('gambling'); // not "interest"
    expect(categorize('International Transaction Fee').category).toBe('fees');
    expect(categorize('Pak N Save Henderson Henderson').shop).toBe('Pak’nSave');
    // A shop you've put in another category stays there.
    expect(categorize('SOME ONLINE GAME CO London', { 'some online': 'gambling' })).toEqual({ category: 'gambling', shop: 'Some Online' });
    const s = summarize(readTransactionsCsv(qExport)!.rows, '2026-11-01', '2026-11-16');
    // Payments in aren't spending, and October is outside the dates.
    expect(s).toMatchObject({ total: 5950, count: 3, small: { count: 2, total: 1950 } });
    expect(s.categories[0]).toMatchObject({ category: 'transport', total: 4000 });
  });
});

describe('review fixes', () => {
  it('a bank export with bill payments and no balance column keeps its signs', () => {
    const r = readTransactionsCsv('Date,Payee,Amount\n01/11/2026,POWER CO BILL PAYMENT,-120.00\n02/11/2026,Countdown,-30.00\n03/11/2026,Salary,900.00')!;
    expect(r.card).toBe(false);
    expect(r.rows.map((t) => t.amount)).toEqual([-12000, -3000, 90000]);
  });

  it('a trailing minus is money out', () => {
    expect([csvAmount('45.20-'), csvAmount('$45.20-')]).toEqual([-4520, -4520]);
  });

  it('a statement read again with different wording isn’t saved twice', () => {
    const b = debtBudget();
    const doc = (desc: string): Extraction => ({ kind: 'transactions', transactions: { rows: [{ date: '2026-11-10', description: desc, amount: -4520 }], card: false, skipped: 0 } });
    upload(b, doc('Pak N Save R'), '2026-11-16', (d) => { d.transactions.target = 'account:everyday'; });
    const again = checkDoc(b, doc('PAK N SAVE R Mt Wgtn'), '2026-11-16', (d) => { d.transactions.target = 'account:everyday'; });
    expect(again.issues.map((i) => i.text).join(' ')).toMatch(/Nothing new/);
  });

  it('a shop with “charge” in its name isn’t a fee', () => {
    expect(categorize('ChargeNet NZ').category).not.toBe('fees');
    expect(categorize('Late payment charge').category).toBe('fees');
  });
});

it('a statement date that jumps backwards was misread: it takes the date above it, and is pointed out', () => {
  const r = fromStatementRows([
    { date: '2026-05-01', description: 'A', amount: '-1.00' }, { date: '2026-04-01', description: 'B', amount: '-2.00' }, { date: '2026-05-02', description: 'C', amount: '-3.00' },
  ], { today: '2026-11-16' });
  expect(r.rows.map((t) => t.date)).toEqual(['2026-05-01', '2026-05-01', '2026-05-02']);
  expect(r.unsure).toBe(1);
});

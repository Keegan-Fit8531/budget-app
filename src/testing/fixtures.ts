import { seedBudget } from '../core/seed';
import type { Budget } from '../core/types';
import { applyProposal } from '../services/reader/apply';
import { type Draft } from '../services/reader/check/draft';
import { review } from '../services/reader/check/review';
import { toDraft } from '../services/reader/check/toDraft';
import type { Extraction } from '../services/reader/types';
import { readTransactionsCsv } from '../services/bank/csv';

/** A blank budget paid on the 19th, with automatic balancing off so amounts are exactly as set. */
export function budget(): Budget {
  const b = structuredClone(seedBudget);
  b.settings.paydayDay = 19;
  b.settings.expectedPay = 500000;
  b.settings.autoBalance = false;
  return b;
}

/**
 * A budget shaped like the real Food and gas account: pay lands in Everyday (…-00, the EFTPOS card), and
 * Food and gas (…-55, Steady) holds three envelopes: Food shop $200 a week (Thursdays), Car gas $250 a
 * month, and Scooter gas $50 a month that only takes fills under $50. $1,250 in it on 22 Nov. Shopping is
 * often done on the Everyday card, then money moved over from Food and gas to cover it.
 */
export function foodGasBudget(): Budget {
  const b = budget();
  b.accounts.push(
    { id: 'day', name: 'Everyday', kind: 'bank', color: '#000', groupId: 'lifestyle', number: '06-0115-0324910-00' },
    { id: 'food', name: 'Food and gas', kind: 'bank', color: '#000', groupId: 'needs', number: '06-0115-0324910-55' },
  );
  b.settings.payAccountId = 'day';
  b.split.push({ accountId: 'food', amount: 0, mode: 'smooth' });
  b.items.push(
    { id: 'shop', name: 'Food shop', amount: 20000, frequency: 'weekly', start: '2026-01-08', accountId: 'food', envelope: 'week' },
    { id: 'car', name: 'Car gas', amount: 25000, frequency: 'monthly', start: '2026-11-01', accountId: 'food', envelope: 'month' },
    { id: 'scoot', name: 'Scooter gas', amount: 5000, frequency: 'monthly', start: '2026-11-01', accountId: 'food', envelope: 'month', envelopeUnder: 5000 },
  );
  b.balances = { food: { amount: 125000, asOf: '2026-11-22' } };
  return b;
}

/** A budget with debts like the real one: a student loan from salary, Gem, a Q card and Afterpay. */
export function debtBudget(): Budget {
  const b = budget();
  for (const id of ['gem', 'qcard', 'afterpay']) {
    b.accounts.push({ id, name: id, kind: 'external', color: '#000', groupId: 'debt' });
    b.split.push({ accountId: id, amount: 0, mode: 'exact' });
  }
  b.debts = [
    { id: 'studentloan', name: 'Student loan', kind: 'loan', accountId: 'studentloan', plans: [], payroll: { perPay: 30000 }, balance: { amount: 2000000, asOf: '2026-11-01' } },
    {
      id: 'gem', name: 'Gem Visa', kind: 'card', rules: 'gem', accountId: 'gem', statementDay: 21, limit: 800000, balance: { amount: 300000, asOf: '2026-11-01' },
      plans: [
        { id: 'g1', name: 'Purchases Jun – Jul 2026', type: 'interest-free', original: 150000, remaining: 120000, asOf: '2026-11-01', purchaseDate: '2026-07-09', ends: '2027-01-20' },
        { id: 'g2', name: 'Purchases Aug – Sep 2026', type: 'interest-free', original: 100000, remaining: 90000, asOf: '2026-11-01', purchaseDate: '2026-09-09', ends: '2027-03-20' },
      ],
    },
    { id: 'qcard', name: 'Q Mastercard', kind: 'card', rules: 'mastercard', accountId: 'qcard', balance: { amount: 50000, asOf: '2026-11-01' }, plans: [] },
    {
      id: 'afterpay', name: 'Afterpay', kind: 'bnpl', rules: 'afterpay', accountId: 'afterpay',
      plans: [
        { id: 'ap-1', name: 'Spotlight NZ', type: 'afterpay', original: 4400, remaining: 1100, asOf: '2026-11-11', purchaseDate: '2026-09-24', instalments: [{ date: '2026-11-19', amount: 1100, label: '4 of 4' }] },
        { id: 'ap-2', name: 'FreshChoice', type: 'afterpay', original: 2466, remaining: 1233, asOf: '2026-11-11', purchaseDate: '2026-10-08', instalments: [{ date: '2026-11-19', amount: 617, label: '3 of 4' }, { date: '2026-12-03', amount: 616, label: '4 of 4' }] },
      ],
    },
  ];
  return b;
}

/** Ids that are the same every run, so a copy and the real change agree. */
export const seq = () => { let n = 0; return () => `new${++n}`; };
export const checkDoc = (b: Budget, ex: Extraction, today: string, edit?: (d: Draft) => void) => {
  const d = toDraft(ex, b, 'gemini', seq(), today);
  edit?.(d);
  return review(d, b, today);
};
/** Read, check and apply a document, as Confirm does. */
export function upload(b: Budget, ex: Extraction, today: string, edit?: (d: Draft) => void) {
  const r = checkDoc(b, ex, today, edit);
  if (!r.proposal) throw new Error(`blocked: ${r.issues.map((i) => i.text).join(' / ')}`);
  applyProposal(b, r.proposal, today);
  return r;
}
export const gemStatement = (date: string, plans: { planId?: string | null; remaining: string; ends: string }[], balance = '2800.00'): Extraction => ({
  kind: 'statement',
  statement: { debtId: 'gem', nameOnDocument: 'Gem Visa', balance: { amount: balance, label: 'Closing balance' }, statementDate: date, plans: plans.map((p) => ({ ...p, remaining: { amount: p.remaining } })) },
});
export const debt = (b: Budget, id: string) => b.debts!.find((d) => d.id === id)!;

// ---------------------------------------------------------------------------------------------
// Bank and card exports (CSV), read on the device. All made up.
// ---------------------------------------------------------------------------------------------

export const qExport = [
  'Date,Card Number,Description,Amount',
  '15/11/26,9999,McDonalds 123 Queen St,-$12.50',
  '12/11/26,,Payment Received - Thank You,$100.00',
  '10/11/26,9999,"SUPERCHEAP AUTO 7 Mth 0% Int, 7 Mth Pmt Hol",-$40.00',
  '05/11/26,9999,Afterpay afterpay.co NZL,$0.00',
  '02/11/26,9999,MYLOTTO.CO.NZ NEW ZEALAND,-$7.00',
  '28/10/26,9999,Countdown Glen Eden,-$30.00',
].join('\n');

export const csvDoc = (text: string): Extraction => ({ kind: 'transactions', transactions: readTransactionsCsv(text)! });

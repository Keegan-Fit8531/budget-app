import { planEnds } from '../debts';
import type { ISODate } from '../dates';
import type { Budget } from '../types';
import type { ReadContext } from './types';

// ---------------------------------------------------------------------------------------------
// What the reader is told, and the fixed form it has to answer in. The reader is sent the names and
// ids of the debts and their plans, and nothing else from the budget.
// ---------------------------------------------------------------------------------------------

const dollars = (c: number) => (c / 100).toFixed(2);

export function buildContext(b: Budget, today: ISODate): ReadContext {
  return {
    today,
    debts: (b.debts ?? []).map((d) => ({
      id: d.id,
      name: d.name,
      kind: d.kind,
      ...(d.rules ? { rules: d.rules } : {}),
      ...(d.payroll ? { neverAStatement: true as const } : {}),
      plans: d.plans.map((p) => {
        const next = p.instalments?.slice().sort((x, y) => x.date.localeCompare(y.date))[0];
        return {
          id: p.id, name: p.name, type: p.type, remaining: dollars(p.remaining),
          ...(p.type === 'interest-free' || p.type === 'equal' ? { ends: planEnds(p) } : {}),
          ...(p.type === 'afterpay' ? { purchaseDate: p.purchaseDate, total: dollars(p.original) } : {}),
          ...(next ? { nextInstalment: { date: next.date, amount: dollars(next.amount) } } : {}),
        };
      }),
    })),
  };
}

export function instructions(today: ISODate): string {
  return [
    'You read one New Zealand financial document for a personal budgeting app: a payslip, a credit card or loan statement (or a card app screen showing what is owed), or a screenshot of the Afterpay app. You fill in the JSON form and nothing else.',
    '',
    'Rules:',
    '- Copy figures exactly as printed. Never add, subtract or work anything out. If a figure is not visible, leave it out.',
    '- Amounts: digits and a decimal point only, like "1240.50". If the document shows an amount as in credit (CR, a minus sign, "in credit"), add " CR" after it.',
    `- Dates: YYYY-MM-DD. New Zealand documents write the day first: 03/11/2026 is 3 November 2026. If a date has no year, use the year that puts it closest to today, ${today}.`,
    '- For each figure, put the words printed next to it on the document in "label".',
    '- kind: "payslip" for a payslip, "statement" for a card or loan statement, "afterpay" for Afterpay orders or instalments, "unknown" if you are not sure.',
    '- Choose debtId and planId ONLY from the list of debts you are given, or null if none fits. Never make one up. Never choose a debt marked neverAStatement.',
    '- Gem Visa statements list interest-free plans with an expiry date. Match each to a plan by its expiry date ("ends"), not by its name, and put that plan\'s balance in "remaining".',
    '- Payments shown on a statement go in paymentsShown only. Purchases go in purchases.',
    '- Afterpay: one order per shop purchase, matched to a plan by shop name and purchase date. List every instalment you can see and mark the paid ones with "paid": true.',
    '- Payslip: payDay is the date the pay goes into the bank; net is the pay that reaches the bank account.',
  ].join('\n');
}

const amt = {
  type: 'object',
  properties: {
    amount: { type: 'string', description: 'Exactly as printed: digits and a decimal point, e.g. "1240.50", plus " CR" if shown as in credit.' },
    label: { type: 'string', description: 'The words printed next to this figure.' },
  },
  required: ['amount'],
};
const date = { type: 'string', description: 'YYYY-MM-DD (the day comes first on NZ documents).' };
const id = { type: ['string', 'null'], description: 'An id from the list given, or null.' };

/** The fixed form, as JSON Schema (Gemini's structured output supports this subset). */
export const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['payslip', 'statement', 'afterpay', 'unknown'] },
    payslip: {
      type: 'object',
      properties: { payDay: date, net: amt, gross: amt, taxableGross: amt, paye: amt, studentLoan: amt, kiwisaver: amt, employerKiwisaver: amt },
    },
    statement: {
      type: 'object',
      properties: {
        debtId: id,
        nameOnDocument: { type: 'string', description: 'The card or lender name printed on the document.' },
        balance: amt,
        inCredit: { type: 'boolean' },
        statementDate: date,
        limit: amt,
        minimum: amt,
        plans: {
          type: 'array',
          items: { type: 'object', properties: { planId: id, description: { type: 'string' }, remaining: amt, ends: date }, required: ['remaining'] },
        },
        purchases: { type: 'array', items: { type: 'object', properties: { date, description: { type: 'string' }, amount: amt } } },
        paymentsShown: { type: 'array', items: { type: 'object', properties: { date, amount: amt } } },
      },
    },
    afterpay: {
      type: 'object',
      properties: {
        orders: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              planId: id,
              merchant: { type: 'string' },
              purchaseDate: date,
              total: amt,
              instalments: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { date, amount: { type: 'string' }, label: { type: 'string', description: 'e.g. "3 of 4"' }, paid: { type: 'boolean' } },
                  required: ['date', 'amount'],
                },
              },
            },
          },
        },
      },
    },
    notes: { type: 'string', description: 'Anything unclear, in a few words.' },
  },
  required: ['kind'],
};

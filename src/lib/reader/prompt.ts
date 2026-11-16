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
      // A card plan's expiry date and balance are left out: given them, Gemini copies them over what the
      // statement says (or misreads the printed date towards them). The app matches statement plans
      // to these by the printed expiry date itself (resolvePlanRow). Afterpay orders have nothing
      // printed to match on, so their dates and amounts are sent.
      plans: d.plans.map((p) => {
        if (p.type !== 'afterpay') return { id: p.id, name: p.name, type: p.type };
        const next = p.instalments?.slice().sort((x, y) => x.date.localeCompare(y.date))[0];
        return {
          id: p.id, name: p.name, type: p.type, remaining: dollars(p.remaining), purchaseDate: p.purchaseDate, total: dollars(p.original),
          ...(next ? { nextInstalment: { date: next.date, amount: dollars(next.amount) } } : {}),
        };
      }),
    })),
  };
}

export function instructions(today: ISODate): string {
  return [
    'You read one New Zealand financial document for a personal budgeting app: a payslip, a credit card or loan statement, a screenshot of a card\'s app (what is owed now and recent purchases), or a screenshot of the Afterpay app. You fill in the JSON form and nothing else.',
    '',
    'Rules:',
    '- Fill in every field of the form. Use null for anything the document doesn\'t show (and for the sections that aren\'t this kind of document), and an empty list when there are none.',
    '- Copy figures exactly as printed. Never add, subtract or work anything out. If a figure is not visible, use null.',
    '- Amounts: digits and a decimal point only, like "1240.50". If the document shows an amount as in credit (CR, a minus sign, "in credit"), add " CR" after it.',
    `- Dates: YYYY-MM-DD. New Zealand documents write the day first: 03/11/2026 is 3 November 2026. If a date has no year, use the year that puts it closest to today, ${today}.`,
    '- For each figure, put the words printed next to it on the document in "label".',
    '- kind: "payslip" for a payslip, "statement" for a card or loan statement or a card app screen, "afterpay" for Afterpay orders or instalments, "unknown" if you are not sure.',
    '- A card app screen (Gem, Q Mastercard or a bank app) is a "statement" with appScreen true: balance is what is owed now (the current balance, not the last statement\'s), available is the available credit, statementDate is null unless the screen shows the date the balance is as at, and every purchase it lists goes in purchases (leave out payments, refunds and pending holds). For a statement, appScreen is false and purchases is empty.',
    '- Choose debtId and planId ONLY from the list of debts you are given, or null if none fits. Never make one up. Never choose a debt marked neverAStatement.',
    '- Gem Visa statements list interest-free plans, each with an expiry date. Put each one in plans with the expiry date printed for it in "ends" and its plan balance in "remaining". Give a planId only if the statement names the plan the same way as one in the list; otherwise null (the app matches plans by their expiry dates). An amount that is not on a plan, such as "Standard purchases", is not a plan.',
    '- Afterpay: one order per shop purchase, matched to a plan by shop name and purchase date. List every instalment you can see and mark the paid ones with "paid": true.',
    '- Payslip: payDay is the date the pay goes into the bank; net is the pay that reaches the bank account.',
  ].join('\n');
}

// Every field is required, with null allowed where a document may not show it. With optional fields
// Gemini sometimes closes the form early (a payslip with only its gross pay, a statement with no
// balance), so it's made to answer each one. parseReply drops the nulls again.
const amt = {
  type: ['object', 'null'],
  properties: {
    amount: { type: 'string', description: 'Exactly as printed: digits and a decimal point, e.g. "1240.50", plus " CR" if shown as in credit.' },
    label: { type: 'string', description: 'The words printed next to this figure.' },
  },
  required: ['amount', 'label'],
  description: 'null if it isn’t on the document.',
};
const date = { type: ['string', 'null'], description: 'YYYY-MM-DD (the day comes first on NZ documents), or null if it isn’t shown.' };
const id = { type: ['string', 'null'], description: 'An id from the list given, or null.' };
const text = (description?: string) => ({ type: ['string', 'null'], ...(description ? { description } : {}) });
/** An object whose fields must all be answered. */
const form = (properties: Record<string, unknown>, nullable = false) => ({ type: nullable ? ['object', 'null'] : 'object', properties, required: Object.keys(properties) });
const list = (items: Record<string, unknown>) => ({ type: 'array', items });

/** The fixed form, as JSON Schema (the subset Gemini's structured output supports). */
export const RESPONSE_SCHEMA = form({
  kind: { type: 'string', enum: ['payslip', 'statement', 'afterpay', 'unknown'] },
  payslip: form({ payDay: date, net: amt, gross: amt, taxableGross: amt, paye: amt, studentLoan: amt, kiwisaver: amt, employerKiwisaver: amt }, true),
  statement: form({
    debtId: id,
    nameOnDocument: text('The card or lender name printed on the document.'),
    appScreen: { type: 'boolean', description: 'true for a screenshot of a card app, false for a statement.' },
    balance: amt,
    available: amt,
    inCredit: { type: 'boolean' },
    statementDate: date,
    limit: amt,
    minimum: amt,
    plans: list(form({ planId: id, description: text(), remaining: amt, ends: date })),
    // Only an app screen's purchases are asked for (a Gem one of $250 or more is a new plan). A
    // statement's are already in its balance and its plans, and copying them was most of the reply.
    purchases: list(form({ date, description: text('The shop, as shown.'), amount: amt })),
  }, true),
  afterpay: form({
    orders: list(form({
      planId: id,
      merchant: text(),
      purchaseDate: date,
      total: amt,
      instalments: list(form({
        date: { type: 'string', description: 'YYYY-MM-DD' },
        amount: { type: 'string' },
        label: text('e.g. "3 of 4"'),
        paid: { type: 'boolean' },
      })),
    })),
  }, true),
  notes: text('Anything unclear, in a few words.'),
});

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
      ...(d.payroll ? (d.kind === 'loan' ? { studentLoan: true as const } : { neverAStatement: true as const }) : {}),
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
    'You read one New Zealand financial document for a personal budgeting app: a payslip, a credit card or loan statement, a screenshot of a card\'s app (what is owed now and recent purchases), a bank account statement (or a screen listing a bank account\'s transactions), a KiwiSaver statement or app screen, a list of bank accounts with their balances, or a screenshot of the Afterpay app. You fill in the JSON form and nothing else.',
    '',
    'Rules:',
    '- Fill in every field of the form. Use null for anything the document doesn\'t show (and for the sections that aren\'t this kind of document), and an empty list when there are none.',
    '- Copy figures exactly as printed. Never add, subtract or work anything out. If a figure is not visible, use null.',
    '- Amounts: digits and a decimal point only, like "1240.50". If the document shows an amount as in credit (CR, a minus sign, "in credit"), add " CR" after it.',
    `- Dates: YYYY-MM-DD. New Zealand documents write the day first: 03/11/2026 is 3 November 2026. If a date has no year, use the year that puts it closest to today, ${today}.`,
    '- For each figure, put the words printed next to it on the document in "label".',
    '- kind: "payslip" for a payslip, "statement" for a credit card or loan statement or a card app screen (it shows what is owed, usually with a credit limit), "account" for a bank account statement or list of a bank account\'s transactions (an everyday, cheque, debit card or savings account: money in and out with a running balance, nothing owed), "afterpay" for Afterpay orders or instalments, "kiwisaver" for a KiwiSaver statement, breakdown or app screen (a retirement fund balance, often split into funds, with contributions and returns; a payslip\'s KiwiSaver deduction is still a "payslip"), "balances" for a list of several bank accounts each with its balance and no transactions (internet banking or a bank app\'s "Current and savings" or "Accounts" page), "unknown" if you are not sure. A bank account is never a "statement".',
    '- A list of bank accounts ("balances"): bank is the bank\'s name, from its logo, wording or layout, or else the account numbers\' first two digits (01 or 06 ANZ, 02 BNZ, 03 Westpac, 12 ASB, 38 Kiwibank, 15 TSB). asOf is the date the balances are shown as at, or null if none is shown. accounts: every account listed, in order, with its name exactly as printed, its number as printed (e.g. "06-0115-0324910-53"), balance (the main balance figure) and available (the "Available" figure, if shown). Leave out credit cards and loans listed with them. One account\'s list of transactions is an "account", not "balances".',
    '- A bank account ("account"): put every transaction in account.rows, in the order printed, each as one line "date|description|amount|balance", like "2026-06-10|Pizza Hut Ho|-8.49|342.51". date: YYYY-MM-DD (a date printed without a year takes the year of the statement period around it). description: who it was paid to or from and what it was (e.g. "Pak N Save R", "SPARK NZ TRADING SALARY"), without card numbers or "Orig date" lines. amount: money out (withdrawals, debits, purchases, payments) with a minus sign, like "-45.20"; money in (deposits, credits) without, like "150.00". balance: the balance printed after it, or nothing if none is printed ("2026-06-10|Pizza Hut Ho|-8.49|"). Leave out opening balances, balances brought forward, and page or statement totals. closingBalance and closingDate: the last balance shown (after the last transaction), and its date.',
    '- A card app screen (Gem, Q Mastercard or a bank app) is a "statement" with appScreen true: balance is what is owed now (the current balance, not the last statement\'s), available is the available credit, statementDate is null unless the screen shows the date the balance is as at, and every purchase it lists goes in purchases — including ones marked Pending (set pending true for those). Leave out payments and refunds. For a statement PDF, appScreen is false and purchases is empty.',
    '- Choose debtId and planId ONLY from the list of debts you are given, or null if none fits. Never make one up. Never choose a debt marked neverAStatement.',
    '- A New Zealand student loan balance from IRD (myIR "Loan breakdown", "Student loan" account or statement) is a "statement" for the debt marked studentLoan: balance is the "Total loan balance" (or the balance owing; on a list of transactions, the latest balance shown), always in balance and never in available, statementDate the date it is as at (the end of the period shown, or today if it shows the balance now), nameOnDocument "IRD student loan". Leave available, limit and minimum null and plans and purchases empty; the fees, costs and deductions listed are not plans or purchases.',
    '- Gem Visa "My plans" (or a statement that lists plans): put each open plan in plans with its plan balance in "remaining", the name as printed in "description", months (6, 12, 24, 36 or 60 when shown), monthsLeft from "X of Y months remaining" (use X), and type "equal" when it is a fixed monthly instalment plan (12/24/36/60) or "interest-free" for a 6-month any-payments plan. ends is the expiry date if printed; otherwise null (the app works it out from monthsLeft — Gem\'s month resets on the 20th). Give a planId only if the statement names the plan the same way as one in the list; otherwise null (the app matches by expiry or name). Skip completed plans. An amount that is not on a plan, such as "Standard purchases", is not a plan.',
    '- Afterpay: one order per shop purchase, matched to a plan by shop name and purchase date. List every instalment you can see and mark the paid ones with "paid": true. Afterpay’s “Upcoming payments” screen (Due in 15/30/60 days, a table of merchants still due) is also "afterpay": set listsAllDue true, and list only the rows still due (each merchant with its amount due, due date, and "Payment no." as the instalment label, e.g. "4 of 4"). Paid-off orders are not on that screen — leave them out. total may be null when only the amount due is shown. A screenshot of one order’s details (not the full upcoming list) has listsAllDue false.',
    '- KiwiSaver: provider is the scheme\'s name (e.g. "Kernel KiwiSaver Plan"). date is the day the balance is as at (the closing date, or "Balance, 13 November"); since is the start of the period the figures cover (the opening value\'s date, or the first date on a chart of all time). balance is the closing value or balance; opening the opening value. employee, employer, government, voluntary and withdrawals are those contributions for the period (Government Contribution is the government\'s, Employee Contributions yours). earnings is "Investment Earnings or Losses (before tax)" (with " CR" or a minus sign if a loss), tax the PIE tax. returns is a returns figure shown on its own, e.g. "Returns (all time)" (the dollar amount, not the %). funds: every fund it\'s invested in with its dollar value (not its weighting or units). Leave out a total "Contributions" line (it is the sum of the others).',
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
  kind: { type: 'string', enum: ['payslip', 'statement', 'account', 'balances', 'afterpay', 'kiwisaver', 'unknown'] },
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
    plans: list(form({
      planId: id, description: text(), remaining: amt, ends: date,
      months: { type: ['number', 'null'], description: 'Total plan length in months when shown (6, 12, 24, 36 or 60).' },
      monthsLeft: { type: ['number', 'null'], description: 'Months still left (the X in “X of Y months remaining”).' },
      type: { type: ['string', 'null'], enum: ['interest-free', 'equal', null], description: 'interest-free for 6-month any-payments plans; equal for fixed monthly instalment plans.' },
    })),
    // App screen purchases (including pending). A Gem one of $250 or more is a new 6-month plan.
    purchases: list(form({
      date, description: text('The shop, as shown.'), amount: amt,
      pending: { type: ['boolean', 'null'], description: 'true when the purchase is marked Pending.' },
    })),
  }, true),
  // A bank account's transactions: the app turns them into the same form as a CSV export's.
  account: form({
    name: text('The account’s name or type as printed, e.g. "Go", "Everyday".'),
    number: text('The account number as printed, e.g. "06-0115-0123456-00".'),
    closingBalance: amt,
    closingDate: date,
    // One line per transaction: about a third of the length of a labelled record, so a long
    // statement comes back three times as fast.
    rows: list({ type: 'string', description: 'date|description|amount|balance, e.g. "2026-06-10|Pizza Hut Ho|-8.49|342.51".' }),
  }, true),
  balances: form({
    bank: text('The bank, e.g. "ANZ".'),
    asOf: date,
    accounts: list(form({ name: text('The account’s name as printed, e.g. "Rent".'), number: text('The account number as printed.'), balance: amt, available: amt })),
  }, true),
  kiwisaver: form({
    provider: text('The KiwiSaver scheme or provider, as printed.'),
    date, since: date,
    balance: amt, opening: amt, employee: amt, employer: amt, government: amt, voluntary: amt, withdrawals: amt, earnings: amt, tax: amt, returns: amt,
    funds: list(form({ name: text('The fund’s name, e.g. "High Growth".'), amount: amt })),
  }, true),
  afterpay: form({
    listsAllDue: { type: ['boolean', 'null'], description: 'true for the Upcoming payments screen (everything still due); false for a single order or a partial list.' },
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

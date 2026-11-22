import { todayISO, type ISODate } from '../../../core/dates';
import { isKiwiSaver } from '../../../features/savings/logic/kiwisaver';
import type { Budget, Debt } from '../../../core/types';
import type { Extraction, Fig, RawStatement, ReaderSource } from '../types';
import { fig, statementDebts, isStudentLoan, afterpayDebt } from './figures';
import { NEW_GOAL, type Draft } from './draft';
import { balancesDraft } from './balances';
import { matchEnding } from './transactions';

// ---------- The reader's answer → a draft ----------

/**
 * The card a document is for, from the name on it, when Gemini didn't pick one: Gem Visa, Q Mastercard
 * and Afterpay are told apart by name (Gem and Q both come from Latitude, so "Latitude" alone isn't enough).
 * Only a single clear match counts.
 */
export function guessDebt(debts: Debt[], text: string): string | undefined {
  const t = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  const tests: [RegExp, (d: Debt) => boolean][] = [
    [/ gem( visa)? /, (d) => d.rules === 'gem' || /\bgem\b/i.test(d.name)],
    [/ q ?(mastercard|card|mc) /, (d) => /^q\b/i.test(d.name) || (d.rules === 'mastercard' && /\bq\b/i.test(d.name))],
    [/ afterpay /, (d) => d.rules === 'afterpay' || /afterpay/i.test(d.name)],
    // IRD's myIR "Loan breakdown" (or anything saying student loan) is the student loan's balance.
    [/ (myir|ird|inland revenue|student loan|loan breakdown) /, isStudentLoan],
  ];
  for (const [re, is] of tests) {
    if (!re.test(t)) continue;
    const hits = debts.filter(is);
    if (hits.length === 1) return hits[0].id;
  }
  const byName = debts.filter((d) => d.name.length >= 4 && t.includes(` ${d.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `));
  return byName.length === 1 ? byName[0].id : undefined;
}

/**
 * IRD's myIR "Loan breakdown" for the student loan: the reader sometimes puts the "Total loan balance"
 * somewhere other than balance (as available, or as a plan line), and the fees, costs and deductions
 * listed above it aren't plans or purchases. Keeps only what's owed.
 */
function studentLoanStatement(s: RawStatement): RawStatement {
  const owing = /total|balance|owing|owed/i;
  const lines: (Fig | undefined)[] = [s.balance, s.available, s.limit, s.minimum, ...(s.plans ?? []).map((r) => r.remaining && { ...r.remaining, label: r.remaining.label ?? r.description })];
  const found = lines.filter((f): f is Fig => !!f?.amount?.trim());
  const balance = s.balance?.amount?.trim() ? s.balance : found.find((f) => owing.test(f.label ?? '')) ?? (s.available?.amount?.trim() ? s.available : undefined);
  return { ...s, balance, available: undefined, limit: undefined, minimum: undefined, avoidInterest: undefined, dueDate: undefined, plans: [], purchases: [] };
}

export function toDraft(ex: Extraction, b: Budget, source: ReaderSource, makeId: () => string, today: ISODate = todayISO()): Draft {
  const p = ex.payslip ?? {};
  const debtIds = new Set(statementDebts(b).map((d) => d.id));
  const read = ex.statement ?? {};
  const readDebt = read.debtId && debtIds.has(read.debtId) ? read.debtId : guessDebt(statementDebts(b), `${read.nameOnDocument ?? ''} ${ex.notes ?? ''}`) ?? '';
  const loan = (b.debts ?? []).find((d) => d.id === readDebt && isStudentLoan(d));
  const s = loan ? studentLoanStatement(read) : read;
  const ap = afterpayDebt(b, undefined);
  return {
    kind: ex.kind,
    source,
    notes: ex.notes,
    payslip: {
      payDay: p.payDay ?? '', net: fig(p.net), gross: fig(p.gross), taxableGross: fig(p.taxableGross), paye: fig(p.paye),
      studentLoan: fig(p.studentLoan), kiwisaver: fig(p.kiwisaver), employerKiwisaver: fig(p.employerKiwisaver),
    },
    statement: {
      // Only an id from the list (the student loan included); anything else is asked about.
      debtId: readDebt,
      newName: s.nameOnDocument ?? '',
      newDebtId: makeId(),
      nameOnDocument: s.nameOnDocument ?? '',
      appScreen: !!s.appScreen,
      balance: fig(s.balance),
      available: fig(s.available),
      inCredit: !!s.inCredit,
      // An app screen shows what's owed now, so with no date on it, it's today's.
      date: s.statementDate ?? (s.appScreen || loan ? today : ''),
      limit: fig(s.limit),
      minimum: fig(s.minimum),
      avoidInterest: fig(s.avoidInterest),
      dueDate: s.dueDate ?? '',
      plans: (s.plans ?? []).map((r) => ({
        planId: r.planId ?? '', description: r.description ?? '', remaining: fig(r.remaining), ends: r.ends ?? '', addAsNew: false, newId: makeId(),
        ...(typeof r.months === 'number' && r.months > 0 ? { months: r.months } : {}),
        ...(typeof r.monthsLeft === 'number' && r.monthsLeft > 0 ? { monthsLeft: r.monthsLeft } : {}),
        ...(r.type === 'interest-free' || r.type === 'equal' ? { type: r.type } : {}),
      })),
      purchases: (s.purchases ?? []).map((x) => ({ date: x.date ?? '', description: x.description ?? '', amount: x.amount?.amount ?? '', add: null, newId: makeId() })),
      payments: (s.paymentsShown ?? []).map((x) => ({ date: x.date ?? '', amount: x.amount?.amount ?? '' })),
    },
    afterpay: {
      debtId: ap?.id ?? '',
      listsAllDue: !!ex.afterpay?.listsAllDue,
      orders: (ex.afterpay?.orders ?? []).map((o) => ({
        planId: o.planId ?? '', merchant: o.merchant ?? '', purchaseDate: o.purchaseDate ?? '', total: fig(o.total), newId: makeId(),
        instalments: (o.instalments ?? []).map((i) => ({ date: i.date ?? '', amount: i.amount ?? '', label: i.label, paid: !!i.paid })),
      })),
    },
    kiwisaver: (() => {
      const k = ex.kiwisaver ?? {};
      const goal = (b.savings ?? []).find(isKiwiSaver);
      return {
        goalId: goal?.id ?? NEW_GOAL, newGoalId: makeId(), newAccountId: makeId(), provider: k.provider ?? '',
        date: k.date ?? '', since: k.since ?? '',
        balance: fig(k.balance), opening: fig(k.opening), employee: fig(k.employee), employer: fig(k.employer), government: fig(k.government),
        voluntary: fig(k.voluntary), withdrawals: fig(k.withdrawals), earnings: fig(k.earnings), tax: fig(k.tax), returns: fig(k.returns),
        funds: (k.funds ?? []).filter((f) => f.name?.trim()).map((f) => ({ name: f.name!.trim(), value: f.amount?.amount ?? '' })),
      };
    })(),
    balances: balancesDraft(ex.balances, b, makeId, today),
    transactions: (() => {
      const read = ex.transactions ?? { rows: [], card: false, skipped: 0 };
      const target = read.ending ? matchEnding(b, read.ending) : '';
      return { target, ...(target ? { matchedBy: read.ending } : {}), read, amount: null, eventId: makeId() };
    })(),
  };
}

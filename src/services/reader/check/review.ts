import { addDays, diffDays, fmtShort, type ISODate } from '../../../core/dates';
import { planEnds } from '../../../features/debts/logic/gem/gem';
import { suggestPlan } from '../../../features/debts/logic/amounts';
import { periodContaining, recordPayday, shiftPeriod } from '../../../engine/periods';
import { cash } from '../../../core/money';
import type { Payslip } from '../payslip';
import { statementEarned, statementIn } from '../../../features/savings/logic/kiwisaver';
import type { Budget, Cents, Debt, DebtPlan, KiwiReading, KiwiStatement } from '../../../core/types';
import {
  NEW_GOAL, NOT_MINE, ENDS_SLACK_DAYS, type DraftFig, type DraftPlanRow, type DraftOrder, type Draft,
  type KiwiFigure, type Issue, type Review,
} from './draft';
import { toCents, validDate, sameName, ordersOnly } from './figures';
import { reviewStatement, reviewAfterpay } from './statement';
import { reviewTransactions } from './transactions';
import { reviewBalances } from './balances';

// ---------- Checking ----------

/** The plan on `debt` a statement row is for: the one it names if the expiry agrees, else the one with that expiry. */
export function resolvePlanRow(row: Pick<DraftPlanRow, 'planId' | 'ends'>, debt: Debt): DebtPlan | undefined {
  if (row.planId === NOT_MINE) return undefined;
  const ends = validDate(row.ends);
  const close = (p: DebtPlan) => !ends || Math.abs(diffDays(planEnds(p), ends)) <= ENDS_SLACK_DAYS;
  const named = debt.plans.find((p) => p.id === row.planId);
  if (named && close(named)) return named;
  if (!ends) return undefined;
  const near = debt.plans
    .filter((p) => (p.type === 'interest-free' || p.type === 'equal') && close(p))
    .sort((x, y) => Math.abs(diffDays(planEnds(x), ends)) - Math.abs(diffDays(planEnds(y), ends)));
  return near[0];
}

/** The Afterpay order on `debt` a screenshot's order is: by id, or by shop with the purchase date or total. */
export function resolveOrder(o: Pick<DraftOrder, 'planId' | 'merchant' | 'purchaseDate'> & { total?: Cents }, debt: Debt): DebtPlan | undefined {
  if (o.planId === NOT_MINE) return undefined;
  const named = debt.plans.find((p) => p.id === o.planId);
  if (named) return named;
  const date = validDate(o.purchaseDate);
  const hits = debt.plans.filter((p) => {
    const name = !!o.merchant && sameName(p.name, o.merchant);
    const sameDate = !!date && p.purchaseDate === date;
    const sameTotal = o.total !== undefined && (p.original === o.total || p.remaining === o.total);
    return (name && (sameDate || sameTotal)) || (sameDate && sameTotal);
  });
  if (hits.length === 1) return hits[0];
  // Upcoming payments often only shows the shop name (no purchase date / order total).
  const byName = o.merchant ? debt.plans.filter((p) => sameName(p.name, o.merchant)) : [];
  return byName.length === 1 ? byName[0] : undefined;
}

/** How long a new purchase on this card is interest-free, if its rules make it a plan of its own (Gem: $250 or more). */
function planMonths(debt: Debt, cents: Cents): number | undefined {
  if (debt.rules !== 'gem') return undefined; // Mastercard: each rise in the balance already gets its own clock
  const s = suggestPlan(debt, cents);
  return s.type === 'interest-free' ? s.months ?? 6 : undefined;
}

export interface PurchaseRow {
  index: number;
  cents: Cents;
  date: ISODate;
  description: string;
  /** Months interest-free if it should be a plan of its own; undefined for an ordinary purchase. */
  months?: number;
  /** One of your plans already for this purchase (same amount). */
  existing?: DebtPlan;
  /** Add it as a new plan: ticked unless you untick it, or it's already a plan. */
  add: boolean;
}

/**
 * The purchases on a card app screen, as they apply to `debt`. They're already in what's owed, so
 * they only matter when the card's rules make one a plan of its own (a Gem purchase of $250 or more is
 * 6 months interest-free); those are offered as new plans unless one of your plans has that amount.
 */
export function purchaseRows(d: Draft, debt: Debt | undefined): PurchaseRow[] {
  const s = d.statement;
  if (!debt || debt.payroll || ordersOnly(debt) || s.plans.length) return [];
  return s.purchases.flatMap((x, index) => {
    const c = toCents(x.amount);
    const date = validDate(x.date);
    if (!c || c.credit || !c.cents || !date) return [];
    const months = planMonths(debt, c.cents);
    // The same amount bought around the same time (a plan from a statement is dated at the statement).
    const existing = months ? debt.plans.find((p) => (p.original === c.cents || p.remaining === c.cents) && Math.abs(diffDays(p.purchaseDate, date)) <= 45) : undefined;
    return [{ index, cents: c.cents, date, description: x.description.trim(), months, existing, add: !!months && !existing && x.add !== false }];
  });
}

export function review(d: Draft, b: Budget, today: ISODate): Review {
  if (d.kind === 'payslip') return reviewPayslip(d, b, today);
  if (d.kind === 'statement') return reviewStatement(d, b, today);
  if (d.kind === 'afterpay') return reviewAfterpay(d, b, today);
  if (d.kind === 'transactions') return reviewTransactions(d, b, today);
  if (d.kind === 'kiwisaver') return reviewKiwiSaver(d, b, today);
  if (d.kind === 'balances') return reviewBalances(d, b, today);
  return { proposal: null, ignored: [], issues: [{ level: 'block', text: 'Couldn’t tell what this document is. Choose Payslip, Card or loan, Bank balances, KiwiSaver or Afterpay above.' }] };
}

function reviewKiwiSaver(d: Draft, b: Budget, today: ISODate): Review {
  const issues: Issue[] = [];
  const block = (text: string) => issues.push({ level: 'block', text });
  const note = (text: string) => issues.push({ level: 'note', text });
  const k = d.kiwisaver;
  const NAMES: Record<KiwiFigure, string> = {
    balance: 'balance', opening: 'opening value', employee: 'employee contributions', employer: 'employer contributions', government: 'government contribution',
    voluntary: 'voluntary contributions', withdrawals: 'withdrawals', earnings: 'investment earnings', tax: 'PIE tax', returns: 'returns',
  };
  // Earnings and returns can be a loss; everything else is an amount, whatever sign it's printed with.
  const amount = (key: KiwiFigure): Cents | undefined => {
    const c = toCents(k[key].value);
    if (c === null) { block(`Check the ${NAMES[key]}: it should look like 1,240.50.`); return undefined; }
    if (!c) return undefined;
    return (key === 'earnings' || key === 'returns') && c.credit ? -c.cents : c.cents;
  };
  const goal = (b.savings ?? []).find((g) => g.id === k.goalId);
  if (k.goalId !== NEW_GOAL && !goal) block('Choose which KiwiSaver this is.');
  const balance = amount('balance');
  if (balance === undefined && !issues.length) block('Enter the balance.');
  const date = validDate(k.date);
  if (!date) block(k.date.trim() ? `Check the date (${k.date}).` : 'Enter the date the balance is as at.');
  else if (date > addDays(today, 1)) block(`The date, ${fmtShort(date)}, is in the future. Check it.`);
  const since = k.since.trim() ? validDate(k.since) : undefined;
  if (k.since.trim() && !since) block(`Check the start date (${k.since}).`);
  else if (since && date && since >= date) block('The start date should be before the balance’s date.');
  const figs = Object.fromEntries((['opening', 'employee', 'employer', 'government', 'voluntary', 'withdrawals', 'earnings', 'tax', 'returns'] as const).map((key) => [key, amount(key)])) as Partial<Record<KiwiFigure, Cents>>;
  const funds: Record<string, Cents> = {};
  for (const f of k.funds) {
    const name = f.name.trim();
    const c = toCents(f.value);
    if (!name) { if (f.value.trim()) block('Give each fund a name.'); continue; }
    if (c === null) block(`Check ${name}’s value: it should look like 1,240.50.`);
    else if (c) funds[name] = (funds[name] ?? 0) + c.cents;
  }
  if (issues.some((i) => i.level === 'block') || balance === undefined || !date) return { proposal: null, issues, ignored: [] };

  const sum = Object.values(funds).reduce((t, v) => t + v, 0);
  if (Object.keys(funds).length && Math.abs(sum - balance) > 100) note(`The funds add up to ${cash(sum)}, not the ${cash(balance)} balance. They’re kept as each fund’s share of it.`);
  const statement: KiwiStatement | undefined = since ? {
    since,
    ...Object.fromEntries((['employee', 'employer', 'government', 'voluntary', 'withdrawals', 'earnings', 'tax', 'returns'] as const).filter((key) => figs[key] !== undefined).map((key) => [key, figs[key]])),
  } : undefined;
  const put = statement && statementIn(statement);
  const earned = statement && statementEarned(statement);
  if (statement && figs.opening !== undefined && put !== undefined && earned !== undefined) {
    const expected = figs.opening + put + earned;
    if (Math.abs(expected - balance) > 100) note(`The opening value, contributions and returns come to ${cash(expected)}, not the ${cash(balance)} balance. Check the figures.`);
  }
  if (!since && (figs.returns !== undefined || figs.earnings !== undefined)) note('There’s no start date for the returns, so only the balance and funds are kept. Add the date they’re from (the opening value’s date) to see them on the chart.');
  if (since && figs.opening === undefined && !(goal?.readings ?? []).some((r) => r.date === since)) note(`There’s no balance for ${fmtShort(since)} (the opening value), so the returns can’t be placed on the chart yet.`);
  if (goal && date < goal.asOf) note(`This is from ${fmtShort(date)}, before the balance you have (${fmtShort(goal.asOf)}), so it’s added to the history and the balance stays.`);

  const readings: KiwiReading[] = [];
  if (since && figs.opening !== undefined) readings.push({ date: since, balance: figs.opening });
  readings.push({ date, balance, ...(Object.keys(funds).length ? { funds } : {}), ...(statement ? { statement } : {}) });
  const goalId = goal?.id ?? k.newGoalId;
  return {
    proposal: { kind: 'kiwisaver', goalId, ...(goal ? {} : { newGoal: { accountId: k.newAccountId, ...(k.provider.trim() ? { note: k.provider.trim() } : {}) } }), readings },
    issues, ignored: [],
  };
}

function reviewPayslip(d: Draft, b: Budget, today: ISODate): Review {
  const issues: Issue[] = [];
  const block = (text: string) => issues.push({ level: 'block', text });
  const note = (text: string) => issues.push({ level: 'note', text });
  const p = d.payslip;
  const amount = (f: DraftFig, name: string): Cents | undefined => {
    const c = toCents(f.value);
    if (c === null) { block(`Check the ${name}: it should look like 1,240.50.`); return undefined; }
    return c?.cents;
  };
  const net = amount(p.net, 'net pay');
  if (p.net.value.trim() === '' || net === 0) block('Enter the pay that reached your account (net).');
  const payDay = validDate(p.payDay);
  if (!payDay) block(p.payDay.trim() ? `Check the pay day (${p.payDay}).` : 'Enter the pay day.');
  else if (payDay > addDays(today, 10)) block(`The pay day, ${fmtShort(payDay)}, is in the future. Check it.`);
  else if (payDay < addDays(today, -400)) block(`The pay day, ${fmtShort(payDay)}, is over a year ago. Check it.`);
  const gross = amount(p.gross, 'gross pay');
  const taxableGross = amount(p.taxableGross, 'taxable gross');
  const paye = amount(p.paye, 'PAYE');
  const studentLoan = amount(p.studentLoan, 'student loan');
  const kiwisaver = amount(p.kiwisaver, 'KiwiSaver');
  const employerKiwisaver = amount(p.employerKiwisaver, 'employer KiwiSaver');
  if (issues.some((i) => i.level === 'block') || !payDay || net === undefined) return { proposal: null, issues, ignored: [] };

  // Cross-check: net should be gross less the deductions (other deductions can explain a gap).
  const g = gross ?? taxableGross;
  if (g !== undefined && paye !== undefined) {
    const expected = g - paye - (studentLoan ?? 0) - (kiwisaver ?? 0);
    if (Math.abs(expected - net) > 100) note(`Net pay (${cash(net)}) isn’t gross (${cash(g)}) less PAYE, student loan and KiwiSaver (${cash(expected)}). Other deductions can explain it; check the net figure.`);
  }
  // Where it lands: a pay day within a few days of payday moves that payday.
  const probe = { ...b, settings: structuredClone(b.settings), payActuals: {}, payslips: {}, overrides: {}, autoBalanced: {} } as Budget;
  const start = recordPayday(probe, payDay);
  if (JSON.stringify(probe.settings.paydayMoves ?? {}) !== JSON.stringify(b.settings.paydayMoves ?? {})) {
    note(`Paid on ${fmtShort(payDay)}, not the usual payday, so that pay will start then and the one before it ends the day before.`);
  }
  const earliest = shiftPeriod(periodContaining(today, b.settings), -1, b.settings).start;
  if (start < earliest) note(`This is the pay from ${fmtShort(start)}. It replaces what’s recorded for that pay.`);
  if (studentLoan && !(b.debts ?? []).some((x) => x.payroll && x.kind === 'loan')) note('A student loan deduction was read, but there’s no student loan set up in Debts to take it off.');
  if (d.source === 'device') note('Read on this device, which only knows one payslip layout: check the figures.');

  const slip: Payslip = { payDay, net };
  if (taxableGross !== undefined || gross !== undefined) slip.taxableGross = taxableGross ?? gross;
  if (paye !== undefined) slip.paye = paye;
  if (studentLoan !== undefined) slip.studentLoan = studentLoan;
  if (kiwisaver !== undefined) slip.kiwisaver = kiwisaver;
  if (employerKiwisaver !== undefined) slip.employerKiwisaver = employerKiwisaver;
  return { proposal: { kind: 'payslip', slip }, issues, ignored: [] };
}

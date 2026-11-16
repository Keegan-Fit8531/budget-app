import { addDays, addMonths, diffDays, fmtShort, toDate, todayISO, toISO, type ISODate } from '../dates';
import { owed, planEnds, suggestPlan } from '../debts';
import { periodContaining, recordPayday, shiftPeriod } from '../engine';
import { cash } from '../money';
import type { Payslip } from '../payslip';
import type { Budget, Cents, Debt, DebtPlan } from '../types';
import type { DocKind, Extraction, Fig, ReaderSource } from './types';

// ---------------------------------------------------------------------------------------------
// Checking what was read. The reader's answer becomes a draft you can correct in the rundown; every
// field of the draft is checked here, and only a draft with no blocking problems becomes a
// Proposal: the exact, typed changes apply.ts makes. Nothing in this file changes the budget.
// ---------------------------------------------------------------------------------------------

export const NEW_DEBT = '__new';
/** Chosen in the rundown: this plan or order isn't one of yours (so it's never matched automatically). */
export const NOT_MINE = '__none';
/** The most any single figure can be: $1,000,000. */
const MAX_CENTS = 100_000_000;
/** How far a statement's plan expiry can be from one of yours and still be the same plan. */
const ENDS_SLACK_DAYS = 5;

export interface DraftFig { value: string; label?: string }

export interface DraftPlanRow { planId: string; description: string; remaining: DraftFig; ends: string; addAsNew: boolean; newId: string }
export interface DraftOrder {
  planId: string;
  merchant: string;
  purchaseDate: string;
  total: DraftFig;
  newId: string;
  instalments: { date: string; amount: string; label?: string; paid: boolean }[];
}

/** A purchase listed on a card app screen. `add` is null until you tick or untick it (then the default applies). */
export interface DraftPurchase { date: string; description: string; amount: string; add: boolean | null; newId: string }

export interface Draft {
  kind: DocKind;
  source: ReaderSource;
  notes?: string;
  payslip: Record<'net' | 'gross' | 'taxableGross' | 'paye' | 'studentLoan' | 'kiwisaver' | 'employerKiwisaver', DraftFig> & { payDay: string };
  statement: {
    debtId: string;
    newName: string;
    newDebtId: string;
    nameOnDocument: string;
    /** A screenshot of the card's app (current balance, recent purchases) rather than a statement. */
    appScreen: boolean;
    balance: DraftFig;
    /** Available credit, used for what's owed (limit less available) when the balance isn't shown. */
    available: DraftFig;
    inCredit: boolean;
    date: string;
    limit: DraftFig;
    minimum: DraftFig;
    plans: DraftPlanRow[];
    purchases: DraftPurchase[];
    payments: { date: string; amount: string }[];
  };
  afterpay: { debtId: string; orders: DraftOrder[] };
}

export interface PlanUpdate { planId: string; remaining: Cents; ends?: ISODate }
export interface OrderUpdate { planId: string; instalments: { date: ISODate; amount: Cents; label?: string }[] }

export type Proposal =
  | { kind: 'payslip'; slip: Payslip }
  | { kind: 'statement'; debtId: string; newDebt?: { name: string }; balance: Cents; inCredit: boolean; date: ISODate; limit?: Cents; plans: PlanUpdate[]; newPlans: DebtPlan[] }
  | { kind: 'afterpay'; debtId: string; updates: OrderUpdate[]; paidOff: string[]; newPlans: DebtPlan[] };

export interface Issue { level: 'block' | 'note'; text: string }
export interface Review { proposal: Proposal | null; issues: Issue[]; ignored: string[] }

// ---------- Figures and dates ----------

/** Text as printed → cents. Undefined when blank, null when it isn't a sensible amount. "CR" or a minus means in credit. */
export function toCents(s: string | undefined): { cents: Cents; credit: boolean } | null | undefined {
  const t = (s ?? '').trim();
  if (!t) return undefined;
  const credit = /\bCR\b/i.test(t) || /^[-−(]/.test(t);
  const clean = t.replace(/NZD|CR|DR|[$,\s()−-]/gi, '');
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  const cents = Math.round(parseFloat(clean) * 100);
  return cents > MAX_CENTS ? null : { cents, credit };
}

/** A real YYYY-MM-DD date between 2000 and 2100, or undefined. */
export function validDate(s: string | undefined): ISODate | undefined {
  const t = (s ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return undefined;
  const y = Number(t.slice(0, 4));
  if (y < 2000 || y > 2100) return undefined;
  return toISO(toDate(t)) === t ? t : undefined;
}

const fig = (f: Fig | undefined): DraftFig => ({ value: f?.amount ?? '', label: f?.label });
const sameName = (a: string, b: string) => {
  const x = a.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const y = b.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return !!x && !!y && (x.includes(y) || y.includes(x));
};

const statementDebts = (b: Budget) => (b.debts ?? []).filter((d) => !d.payroll);
const afterpayDebt = (b: Budget, id?: string): Debt | undefined =>
  (b.debts ?? []).find((d) => d.id === id && (d.rules === 'afterpay' || d.kind === 'bnpl'))
  ?? (b.debts ?? []).find((d) => d.rules === 'afterpay' || d.kind === 'bnpl');
/** A debt worked out from its orders, with no balance entered (Afterpay). It must never be given a balance. */
const ordersOnly = (d: Debt) => (d.rules === 'afterpay' || d.kind === 'bnpl') && !d.balance;
/** Debts whose statements list plans that are kept one by one (Gem's interest-free plans). */
const keepsPlans = (d: Debt) => d.rules === 'gem' || d.plans.some((p) => p.type === 'interest-free' || p.type === 'equal');

// ---------- The reader's answer → a draft ----------

export function toDraft(ex: Extraction, b: Budget, source: ReaderSource, makeId: () => string, today: ISODate = todayISO()): Draft {
  const p = ex.payslip ?? {};
  const s = ex.statement ?? {};
  const debtIds = new Set(statementDebts(b).map((d) => d.id));
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
      // Only an id from the list, and never the student loan; anything else is asked about.
      debtId: s.debtId && debtIds.has(s.debtId) ? s.debtId : '',
      newName: s.nameOnDocument ?? '',
      newDebtId: makeId(),
      nameOnDocument: s.nameOnDocument ?? '',
      appScreen: !!s.appScreen,
      balance: fig(s.balance),
      available: fig(s.available),
      inCredit: !!s.inCredit,
      // An app screen shows what's owed now, so with no date on it, it's today's.
      date: s.statementDate ?? (s.appScreen ? today : ''),
      limit: fig(s.limit),
      minimum: fig(s.minimum),
      plans: (s.plans ?? []).map((r) => ({ planId: r.planId ?? '', description: r.description ?? '', remaining: fig(r.remaining), ends: r.ends ?? '', addAsNew: false, newId: makeId() })),
      purchases: (s.purchases ?? []).map((x) => ({ date: x.date ?? '', description: x.description ?? '', amount: x.amount?.amount ?? '', add: null, newId: makeId() })),
      payments: (s.paymentsShown ?? []).map((x) => ({ date: x.date ?? '', amount: x.amount?.amount ?? '' })),
    },
    afterpay: {
      debtId: ap?.id ?? '',
      orders: (ex.afterpay?.orders ?? []).map((o) => ({
        planId: o.planId ?? '', merchant: o.merchant ?? '', purchaseDate: o.purchaseDate ?? '', total: fig(o.total), newId: makeId(),
        instalments: (o.instalments ?? []).map((i) => ({ date: i.date ?? '', amount: i.amount ?? '', label: i.label, paid: !!i.paid })),
      })),
    },
  };
}

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
    const sameTotal = o.total !== undefined && p.original === o.total;
    return (name && (sameDate || sameTotal)) || (sameDate && sameTotal);
  });
  return hits.length === 1 ? hits[0] : undefined;
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
    const existing = months ? debt.plans.find((p) => p.original === c.cents || (p.purchaseDate === date && p.remaining === c.cents)) : undefined;
    return [{ index, cents: c.cents, date, description: x.description.trim(), months, existing, add: !!months && !existing && x.add !== false }];
  });
}

export function review(d: Draft, b: Budget, today: ISODate): Review {
  if (d.kind === 'payslip') return reviewPayslip(d, b, today);
  if (d.kind === 'statement') return reviewStatement(d, b, today);
  if (d.kind === 'afterpay') return reviewAfterpay(d, b, today);
  return { proposal: null, ignored: [], issues: [{ level: 'block', text: 'Couldn’t tell what this document is. Choose Payslip, Statement or Afterpay above.' }] };
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

function reviewStatement(d: Draft, b: Budget, today: ISODate): Review {
  const issues: Issue[] = [];
  const ignored: string[] = [];
  const block = (text: string) => issues.push({ level: 'block', text });
  const note = (text: string) => issues.push({ level: 'note', text });
  const s = d.statement;
  const isNew = s.debtId === NEW_DEBT;
  const debt = isNew ? undefined : (b.debts ?? []).find((x) => x.id === s.debtId);

  if (isNew) { if (!s.newName.trim()) block('Give the new debt a name.'); }
  else if (!debt) block(s.nameOnDocument ? `Choose which debt this statement is for (it says “${s.nameOnDocument}”).` : 'Choose which debt this statement is for.');
  else if (debt.payroll) block(`${debt.name} comes out of your pay, so it isn’t updated from a statement. Choose the card or loan this is for.`);
  else if (ordersOnly(debt)) block(`${debt.name} is worked out from its orders, not a balance. Upload a screenshot of your Afterpay orders instead.`);

  let bal = toCents(s.balance.value);
  if (bal === undefined) {
    // Some app screens show only what's available: what's owed is the limit less that.
    const av = toCents(s.available.value);
    const lim = toCents(s.limit.value)?.cents ?? debt?.limit;
    if (av && !av.credit && lim && av.cents <= lim) {
      bal = { cents: lim - av.cents, credit: false };
      note(`Only what’s available (${cash(av.cents)}) is shown, so what’s owed is the ${cash(lim)} limit less that: ${cash(lim - av.cents)}.`);
    }
  }
  if (bal === undefined) block('Enter what’s owed.');
  else if (bal === null) block('Check what’s owed: it should look like 1,240.50.');
  const credit = !!bal && (bal.credit || s.inCredit);
  const balance = bal ? (credit ? 0 : bal.cents) : undefined;
  if (credit) note('The statement is in credit, so nothing is owed.');

  const date = validDate(s.date);
  if (!date) block(s.date.trim() ? `Check the date (${s.date}).` : 'Enter the date what’s owed is as at.');
  else if (date > today) note(`The statement is dated ${fmtShort(date)}, after today, so it’s treated as today.`);
  else if (date < addDays(today, -400)) block(`The statement date, ${fmtShort(date)}, is over a year ago. Check it.`);

  const lim = toCents(s.limit.value);
  if (lim === null) block('Check the credit limit.');
  const limit = lim && lim.cents > 0 ? lim.cents : undefined;

  const plans: PlanUpdate[] = [];
  const newPlans: DebtPlan[] = [];
  if (debt && !debt.payroll && !ordersOnly(debt) && balance !== undefined) {
    const max = limit ?? debt.limit;
    if (max && balance > max) note(`What’s owed (${cash(balance)}) is more than the credit limit (${cash(max)}). Check the figures.`);
    const now = owed(debt);
    if (Math.abs(balance - now) > 100000 || (now > 0 && Math.abs(balance - now) > now * 0.5)) {
      note(`That’s a big change from the ${cash(now)} ${debt.name} shows now. Check it’s the right figure and the right debt.`);
    }
  }
  if (debt && keepsPlans(debt)) {
    const used = new Map<string, string>();
    let unmatched = 0;
    for (const row of s.plans) {
      const rem = toCents(row.remaining.value);
      const what = row.description || (validDate(row.ends) ? `Plan ending ${fmtShort(row.ends)}` : 'A plan');
      if (!rem) { block(`Check the amount left on “${what}”.`); continue; }
      const plan = resolvePlanRow(row, debt);
      if (plan) {
        if (used.has(plan.id)) { block(`Two plans on the statement matched ${plan.name}. Check them.`); continue; }
        used.set(plan.id, what);
        const ends = validDate(row.ends);
        plans.push({ planId: plan.id, remaining: rem.credit ? 0 : rem.cents, ...(ends && ends !== planEnds(plan) ? { ends } : {}) });
      } else if (row.addAsNew) {
        const ends = validDate(row.ends);
        if (!ends) { block(`Enter when “${what}” stops being interest-free, to add it as a new plan.`); continue; }
        const asOf = date && date <= today ? date : today;
        newPlans.push({ id: row.newId, name: row.description || `Interest-free until ${fmtShort(ends)}`, type: 'interest-free', original: rem.cents, remaining: rem.cents, asOf, purchaseDate: asOf, ends });
      } else {
        unmatched++;
        ignored.push(`${what}: ${cash(rem.cents)}${validDate(row.ends) ? `, ends ${fmtShort(row.ends)}` : ''}. It didn’t match one of your plans (tick it to add it as a new one).`);
      }
    }
    if (unmatched) note(`${unmatched === 1 ? 'A plan' : `${unmatched} plans`} on the statement didn’t match one of yours. See “Not changed”.`);
    if (s.plans.length) for (const p of debt.plans) if (!used.has(p.id)) ignored.push(`${p.name}: not on this statement, left as it is.`);
    if (debt.rules === 'gem' && debt.plans.length && !plans.length && !s.appScreen) {
      note('None of the Gem plans were updated, so the difference between the balance and the plans counts as “other purchases”, which are paid first. That changes the recommended payment.');
    }
    const planTotal = [...plans, ...newPlans].reduce((t, x) => t + x.remaining, 0);
    if (balance !== undefined && planTotal > balance + 100) note('The plans add up to more than what’s owed. Check them.');
  } else if (s.plans.length) {
    ignored.push(`${s.plans.length === 1 ? 'A plan' : `${s.plans.length} plans`} listed on the statement: the balance already covers ${s.plans.length === 1 ? 'it' : 'them'}.`);
  }
  const rows = purchaseRows(d, debt);
  const asOf = date && date <= today ? date : today;
  for (const row of rows) {
    const what = `${row.description || 'Purchase'} ${cash(row.cents)} on ${fmtShort(row.date)}`;
    if (!row.months) continue;
    if (row.existing) { ignored.push(`${what}: already your plan “${row.existing.name}”.`); continue; }
    if (!row.add) { ignored.push(`${what}: not added as a plan (tick it to add it).`); continue; }
    const ends = addMonths(row.date, row.months);
    newPlans.push({ id: s.purchases[row.index].newId, name: row.description || `Purchase on ${fmtShort(row.date)}`, type: 'interest-free', months: row.months, original: row.cents, remaining: row.cents, asOf, purchaseDate: row.date, ends });
  }
  const added = newPlans.filter((x) => s.purchases.some((y) => y.newId === x.id));
  if (debt && added.length && balance !== undefined) {
    const planned = debt.plans.reduce((t, x) => t + (plans.find((u) => u.planId === x.id)?.remaining ?? x.remaining), 0) + added.reduce((t, x) => t + x.remaining, 0);
    if (planned > balance + 100) note(`With ${added.length === 1 ? 'that new plan' : 'those new plans'}, your plans add up to ${cash(planned)}, more than the ${cash(balance)} owed. Some may be paid off or already plans: check them.`);
  }
  const others = s.purchases.length - rows.filter((r) => r.months).length;
  if (others > 0) ignored.push(`${others === 1 ? 'A purchase' : `${others} purchases`} on the ${s.appScreen ? 'screenshot' : 'statement'}: already in what’s owed.`);
  for (const x of s.payments) ignored.push(`Payment${x.amount ? ` of ${cash(toCents(x.amount)?.cents ?? 0)}` : ''}${validDate(x.date) ? ` on ${fmtShort(x.date)}` : ''}: payments are counted automatically on their due dates.`);
  if (d.source === 'device' && debt) note(`Read on this device, which guesses the debt from words in the statement: check it’s ${debt.name}.`);

  if (issues.some((i) => i.level === 'block') || balance === undefined || !date) return { proposal: null, issues, ignored };
  return {
    proposal: {
      kind: 'statement', debtId: isNew ? s.newDebtId : s.debtId, ...(isNew ? { newDebt: { name: s.newName.trim() } } : {}),
      balance, inCredit: credit, date, ...(limit ? { limit } : {}), plans, newPlans,
    },
    issues, ignored,
  };
}

function reviewAfterpay(d: Draft, b: Budget, today: ISODate): Review {
  const issues: Issue[] = [];
  const ignored: string[] = [];
  const block = (text: string) => issues.push({ level: 'block', text });
  const note = (text: string) => issues.push({ level: 'note', text });
  const debt = afterpayDebt(b, d.afterpay.debtId);
  if (!debt) return { proposal: null, ignored, issues: [{ level: 'block', text: 'There’s no Afterpay set up in Debts yet. Add it there first.' }] };
  if (!d.afterpay.orders.length) block('No orders were found. Try a screenshot that shows your orders and their instalments.');

  const updates: OrderUpdate[] = [];
  const paidOff: string[] = [];
  const newPlans: DebtPlan[] = [];
  const used = new Set<string>();
  for (const o of d.afterpay.orders) {
    const name = o.merchant || 'An order';
    const total = toCents(o.total.value);
    if (total === null) { block(`Check the total for ${name}.`); continue; }
    const inst: { date: ISODate; amount: Cents; label?: string; paid: boolean }[] = [];
    let bad = false;
    for (const i of o.instalments) {
      const date = validDate(i.date);
      const c = toCents(i.amount);
      if (!date || !c) { bad = true; continue; }
      inst.push({ date, amount: c.cents, label: i.label, paid: i.paid });
    }
    if (bad) { block(`Check the instalments for ${name}: a date or amount couldn’t be read.`); continue; }
    // Only instalments still to come: anything paid or due before today is already counted.
    const keep = inst.filter((i) => !i.paid && i.date >= today).sort((x, y) => x.date.localeCompare(y.date)).map(({ date, amount, label }) => ({ date, amount, ...(label ? { label } : {}) }));
    const done = inst.length - keep.length;
    if (done) ignored.push(`${name}: ${done} instalment${done === 1 ? '' : 's'} already paid or due before today, already counted.`);
    const all = inst.reduce((t, i) => t + i.amount, 0);
    if (total?.cents && inst.length >= 4 && Math.abs(all - total.cents) > 4) note(`${name}: the instalments add up to ${cash(all)}, not the total of ${cash(total.cents)}. Check them.`);

    const plan = resolveOrder({ ...o, total: total?.cents }, debt);
    if (plan) {
      if (used.has(plan.id)) { block(`Two orders on the screenshot matched ${plan.name}. Check them.`); continue; }
      used.add(plan.id);
      if (!keep.length) paidOff.push(plan.id);
      else updates.push({ planId: plan.id, instalments: keep });
    } else if (!keep.length) {
      ignored.push(`${name}: fully paid, so it isn’t added.`);
    } else {
      const purchaseDate = validDate(o.purchaseDate) ?? today;
      newPlans.push({
        id: o.newId, name: o.merchant.trim() || 'Afterpay order', type: 'afterpay', original: total?.cents || all, remaining: keep.reduce((t, i) => t + i.amount, 0),
        asOf: today, purchaseDate, instalments: keep,
      });
    }
  }
  const others = debt.plans.filter((p) => !used.has(p.id)).length;
  if (others && (updates.length || paidOff.length || newPlans.length)) ignored.push(`${others} other order${others === 1 ? '' : 's'} not on this screenshot: left as ${others === 1 ? 'it is' : 'they are'}.`);
  if (issues.some((i) => i.level === 'block')) return { proposal: null, issues, ignored };
  if (!updates.length && !paidOff.length && !newPlans.length) {
    return { proposal: null, ignored, issues: [...issues, { level: 'block', text: 'Nothing to change: every order on the screenshot is already paid.' }] };
  }
  return { proposal: { kind: 'afterpay', debtId: debt.id, updates, paidOff, newPlans }, issues, ignored };
}

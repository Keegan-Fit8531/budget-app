import { nextColor } from '../colors';
import { fmtDay, fmtShort, fmtSpan, monthName, type ISODate } from '../dates';
import { applyPayment, debtPay, exactForFirstPlan, owed, planEnds, recordHistory, settleDue } from '../debts';
import { recordPayslip } from '../documents';
import { paydayFor, periodContaining, planFor, recordPayday } from '../engine';
import { cash } from '../money';
import { autoBalance, autoPays } from '../rebalance';
import { setBalance } from '../history';
import { recordReading, statementEarned, statementIn } from '../kiwisaver';
import type { Budget, Cents, Debt, PaidPayment, Txn } from '../types';
import type { Proposal } from './check';

// ---------------------------------------------------------------------------------------------
// Applying a checked Proposal. applyProposal is a plain function on a budget, so it runs first on a
// copy (for the rundown and Undo) and then, unchanged, inside store.update(). Savings goals, deposits
// and account balances are never edited here: they only move when the next 12 pays rebalance.
// ---------------------------------------------------------------------------------------------

export function applyProposal(b: Budget, p: Proposal, today: ISODate): Budget {
  // A document about a card or Afterpay: note the day, so its card shows when it was last brought up to date.
  const debtId = p.kind === 'statement' || p.kind === 'afterpay' ? p.debtId : p.kind === 'transactions' && p.target.type === 'debt' ? p.target.id : undefined;
  if (debtId) {
    const run = applyProposalInner(b, p, today);
    const d = (run.debts ?? []).find((x) => x.id === debtId);
    if (d) d.checkedOn = today;
    return run;
  }
  return applyProposalInner(b, p, today);
}

function applyProposalInner(b: Budget, p: Proposal, today: ISODate): Budget {
  if (p.kind === 'payslip') { recordPayslip(b, p.slip); return b; }
  if (p.kind === 'transactions') { applyTransactions(b, p, today); return b; }
  if (p.kind === 'kiwisaver') { applyKiwiSaver(b, p); return b; }
  if (p.kind === 'balances') { applyBalances(b, p); return b; }
  if (p.kind === 'statement') {
    if (p.newDebt) addDebt(b, p.debtId, p.newDebt.name);
    applyStatement(b, p.debtId, p, today);
    return b;
  }
  const debt = (b.debts ?? []).find((d) => d.id === p.debtId);
  if (!debt) return b;
  // Instalments dropped from a pay that has started stay on that pay's total (same idea as settleDue).
  const dropped: PaidPayment[] = [];
  const noteDropped = (plan: { id: string; name: string }, date: ISODate, amount: Cents) => {
    if (amount <= 0) return;
    const pay = periodContaining(date, b.settings);
    if (pay.start > today) return; // still in a future pay: leave it off until it's due
    if ((debt.paid ?? []).some((x) => x.date === date && x.amount === amount && (x.planId === plan.id || x.name === plan.name))) return;
    dropped.push({ date, amount, name: plan.name, planId: plan.id });
  };
  for (const u of p.updates) {
    const plan = debt.plans.find((x) => x.id === u.planId);
    if (!plan) continue;
    for (const old of plan.instalments ?? []) {
      const kept = u.instalments.find((i) => i.date === old.date);
      if (!kept) noteDropped(plan, old.date, old.amount);
      else if (kept.amount < old.amount) noteDropped(plan, old.date, old.amount - kept.amount);
    }
    // The screenshot's instalments replace the ones saved: never added on top.
    plan.instalments = u.instalments.map((i) => ({ ...i }));
    plan.remaining = u.instalments.reduce((t, i) => t + i.amount, 0);
    plan.asOf = today;
  }
  for (const id of p.paidOff) {
    const plan = debt.plans.find((x) => x.id === id);
    if (!plan) continue;
    for (const i of plan.instalments ?? []) noteDropped(plan, i.date, i.amount);
  }
  if (dropped.length) {
    debt.paid = [...(debt.paid ?? []), ...dropped].sort((a, b) => a.date.localeCompare(b.date)).slice(-300);
  }
  if (p.paidOff.length) debt.plans = debt.plans.filter((x) => !p.paidOff.includes(x.id));
  for (const np of p.newPlans) {
    if (debt.plans.some((x) => x.id === np.id)) continue;
    debt.plans.push(structuredClone(np));
    exactForFirstPlan(b, debt);
  }
  recordHistory(debt, today);
  return b;
}

/** The most transactions kept for one card or account (a few years of a busy card). */
const MAX_TXNS = 3000;

/**
 * A bank or card export: its new transactions are kept on that card or account, the card or account
 * number is remembered (so the next export is matched to it), and what's owed or in the account is
 * set, as at the export's last day, when it was worked out or typed in.
 */
function applyTransactions(b: Budget, p: Extract<Proposal, { kind: 'transactions' }>, today: ISODate): void {
  const merge = (list: Txn[] = []) => [...list, ...p.add.map((t) => ({ ...t }))].sort((x, y) => x.date.localeCompare(y.date)).slice(-MAX_TXNS);
  if (p.target.type === 'debt') {
    const debt = (b.debts ?? []).find((d) => d.id === p.target.id);
    if (!debt) return;
    debt.transactions = merge(debt.transactions);
    if (p.ending && !debt.ending) debt.ending = p.ending;
    if (p.balance) applyStatement(b, debt.id, { balance: p.balance.amount, date: p.balance.asOf, plans: [], newPlans: [] }, today);
    if (p.history.length) {
      const days = new Set(p.history.map((h) => h.asOf));
      debt.history = [...(debt.history ?? []).filter((h) => !days.has(h.asOf)), ...p.history].sort((x, y) => x.asOf.localeCompare(y.asOf)).slice(-500);
    }
    return;
  }
  const account = b.accounts.find((a) => a.id === p.target.id);
  if (!account) return;
  b.accountTransactions = { ...(b.accountTransactions ?? {}), [account.id]: merge(b.accountTransactions?.[account.id]) };
  if (p.ending && !account.ending) account.ending = p.ending;
  if (p.balance) setBalance(b, account.id, p.balance.amount, p.balance.asOf, p.eventId);
}

/** A bank's list of balances: each account's balance is set, as at the day shown, and its number kept. */
function applyBalances(b: Budget, p: Extract<Proposal, { kind: 'balances' }>): void {
  for (const [i, x] of p.set.entries()) {
    const account = b.accounts.find((a) => a.id === x.accountId);
    if (!account) continue;
    if (x.number && !account.number) account.number = x.number;
    setBalance(b, account.id, x.amount, p.asOf, `${p.eventId}-${i}`);
  }
}

/** A debt that isn't set up yet: added with its own payday account, paid from the split like any other. */
function addDebt(b: Budget, id: string, name: string): void {
  if ((b.debts ?? []).some((d) => d.id === id)) return;
  b.debts = b.debts ?? [];
  const groupId = b.groups.find((g) => g.id === 'debt')?.id ?? b.groups.find((g) => g.bucket === 'savings')?.id ?? b.groups[0]?.id ?? '';
  b.accounts.push({ id, name, kind: 'external', color: nextColor(b.accounts.map((x) => x.color)), groupId });
  b.split.push({ accountId: id, amount: 0, mode: 'exact' });
  b.debts.push({ id, name, kind: 'card', accountId: id, plans: [] });
}

const belongsTo = (x: PaidPayment, plan: { id: string; name: string }) => (x.planId ? x.planId === plan.id : x.name === plan.name);

/**
 * Put a debt back as it was on `asOf`, so a statement from that date can be applied and the payments
 * since then counted once. Each plan gets back what was counted as paid on it since then; those
 * payments (and the "other purchases" ones) are taken out of the paid list, to be counted again.
 * Plans with exact instalments (Afterpay) can't be put back, so their payments are kept as they are,
 * as are payments to plans that have since been paid off and removed.
 */
/** A KiwiSaver statement: its balances go into the goal's history (a new goal if it's the first). Payday never sends KiwiSaver anything. */
export function applyKiwiSaver(b: Budget, p: Extract<Proposal, { kind: 'kiwisaver' }>): void {
  b.savings = b.savings ?? [];
  let goal = b.savings.find((g) => g.id === p.goalId);
  if (!goal && p.newGoal) {
    const groupId = b.groups.find((g) => g.id === 'savings')?.id ?? b.groups.find((g) => g.bucket === 'savings')?.id ?? b.groups[0]?.id ?? '';
    b.accounts.push({ id: p.newGoal.accountId, name: 'KiwiSaver', kind: 'bank', color: nextColor(b.accounts.map((x) => x.color)), groupId });
    const first = p.readings[0];
    goal = { id: p.goalId, name: 'KiwiSaver', accountId: p.newGoal.accountId, balance: first.balance, asOf: first.date, kiwisaver: true, ...(p.newGoal.note ? { note: p.newGoal.note } : {}) };
    b.savings.push(goal);
  }
  if (!goal) return;
  for (const r of p.readings) recordReading(goal, structuredClone(r));
}

export function windBack(debt: Debt, asOf: ISODate): void {
  const since = (debt.paid ?? []).filter((x) => x.date >= asOf);
  const wound = debt.plans.filter((p) => !p.instalments?.length);
  for (const plan of wound) {
    const back = since.filter((x) => !x.synthetic && belongsTo(x, plan)).reduce((t, x) => t + x.amount, 0);
    plan.remaining += back;
    plan.asOf = asOf;
  }
  if (debt.paid) debt.paid = debt.paid.filter((x) => x.date < asOf || (!x.synthetic && !wound.some((p) => belongsTo(x, p))));
}

/** Set what a debt owes, and each plan on the statement, as at the statement date; then count the payments since. */
export function applyStatement(b: Budget, debtId: string, s: Pick<Extract<Proposal, { kind: 'statement' }>, 'balance' | 'date' | 'limit' | 'plans' | 'newPlans'>, today: ISODate): Debt | undefined {
  const debt = (b.debts ?? []).find((d) => d.id === debtId);
  if (!debt) return undefined;
  const asOf = s.date <= today ? s.date : today;
  if (asOf < today) windBack(debt, asOf);
  debt.balance = { amount: s.balance, asOf };
  debt.checked = { amount: s.balance, asOf };
  if (s.limit !== undefined && s.limit > 0) debt.limit = s.limit;
  for (const u of s.plans) {
    const plan = debt.plans.find((x) => x.id === u.planId);
    if (!plan) continue;
    plan.remaining = u.remaining;
    plan.asOf = asOf;
    if (u.ends) plan.ends = u.ends;
    if (u.months) plan.months = u.months;
    if (u.type) plan.type = u.type;
  }
  for (const np of s.newPlans) {
    if (debt.plans.some((x) => x.id === np.id)) continue;
    debt.plans.push({ ...structuredClone(np), asOf, purchaseDate: np.purchaseDate > asOf ? asOf : np.purchaseDate });
    exactForFirstPlan(b, debt);
  }
  const hist = (debt.history ?? []).filter((h) => h.asOf !== asOf);
  hist.push({ amount: owed(debt), asOf });
  debt.history = hist.sort((x, y) => x.asOf.localeCompare(y.asOf)).slice(-500);
  if (asOf < today) {
    settleDue(debt, b.settings, today, debtPay(b, debt));
    // Payments seen leaving your bank after this statement's date aren't in it: what they paid over the
    // plan comes off again, so the statement and the bank together give the latest figure.
    const extra = (debt.bankPayments ?? []).filter((x) => x.date > asOf && x.counted > 0);
    for (const x of extra) applyPayment(debt, x.counted, b.settings, x.date <= today ? x.date : today);
  }
  return debt;
}

// ---------- The rundown ----------

export interface PayChange { account: string; pays: number; first: { date: ISODate; from: Cents; to: Cents } }

export interface Preview {
  after: Budget;
  /** What changes, one line each, old → new. */
  lines: string[];
  /** Why a figure may not be the document's own (an older statement, a moved payday). */
  explain: string[];
  /** Payday amounts that change across the next 12 pays, by account. */
  payChanges: PayChange[];
  payChangeCount: number;
  /** For a payslip: the pay it went to. */
  payStart?: ISODate;
}

/** Work out the change on a copy: what the budget would be, and what to tell you about it. */
export function preview(before: Budget, p: Proposal, today: ISODate): Preview {
  const after = autoBalance(applyProposal(structuredClone(before), p, today), today);
  const lines: string[] = [];
  const explain: string[] = [];
  let payStart: ISODate | undefined;
  const debtOf = (b: Budget, id: string) => (b.debts ?? []).find((d) => d.id === id);

  if (p.kind === 'payslip') {
    const probe = { ...before, settings: structuredClone(before.settings), payActuals: { ...before.payActuals }, payslips: {}, overrides: {}, autoBalanced: {} } as Budget;
    const start = recordPayday(probe, p.slip.payDay);
    payStart = start;
    const was = probe.payActuals[start];
    lines.push(`${monthName(start)} pay, paid ${fmtDay(p.slip.payDay)}: ${was !== undefined && was !== p.slip.net ? `${cash(was)} → ` : ''}${cash(p.slip.net)}${was === p.slip.net ? ' (already recorded)' : ''}`);
    const movesBefore = before.settings.paydayMoves ?? {};
    const movesAfter = after.settings.paydayMoves ?? {};
    const moved = Object.keys(movesAfter).find((k) => movesAfter[k] !== movesBefore[k]);
    if (moved) {
      const [y, m] = moved.split('-').map(Number);
      const rest = Object.fromEntries(Object.entries(movesBefore).filter(([k]) => k !== moved));
      const from = movesBefore[moved] ?? paydayFor(y, m - 1, { ...before.settings, paydayMoves: rest });
      lines.push(`That payday moves from ${fmtShort(from)} to ${fmtShort(p.slip.payDay)}.`);
    }
    const parts = [p.slip.paye !== undefined && `PAYE ${cash(p.slip.paye)}`, p.slip.kiwisaver !== undefined && `KiwiSaver ${cash(p.slip.kiwisaver)}`, p.slip.employerKiwisaver !== undefined && `employer KiwiSaver ${cash(p.slip.employerKiwisaver)}`].filter(Boolean);
    if (parts.length) lines.push(`Payslip details saved: ${parts.join(' · ')}.`);
    const loanBefore = (before.debts ?? []).find((d) => d.payroll && d.kind === 'loan');
    const loanAfter = loanBefore && debtOf(after, loanBefore.id);
    if (loanBefore && loanAfter && owed(loanBefore) !== owed(loanAfter)) lines.push(`${loanBefore.name}: ${cash(owed(loanBefore))} → ${cash(owed(loanAfter))} owed (the payslip’s ${cash(p.slip.studentLoan ?? 0)} deduction).`);
  } else if (p.kind === 'kiwisaver') {
    const was = (before.savings ?? []).find((g) => g.id === p.goalId);
    const now = (after.savings ?? []).find((g) => g.id === p.goalId)!;
    const last = p.readings[p.readings.length - 1];
    if (!was) lines.push('New savings goal: KiwiSaver, paid from your salary (payday sends it nothing).');
    if (!was || now.balance !== was.balance) lines.push(`${now.name}: balance ${was ? `${cash(was.balance)} → ` : ''}${cash(now.balance)}, as at ${fmtShort(now.asOf)}`);
    if (last.funds) lines.push(`Funds: ${Object.entries(last.funds).map(([n, v]) => `${n} ${cash(v)}`).join(' · ')}`);
    const s = last.statement;
    const put = s && statementIn(s);
    const earned = s && statementEarned(s);
    if (s && (put !== undefined || earned !== undefined)) {
      const parts = [put !== undefined && `${cash(put)} went in`, earned !== undefined && `${earned < 0 ? `lost ${cash(-earned)}` : `earned ${cash(earned)}`}${s.tax ? ' after PIE tax' : ''}`].filter(Boolean);
      lines.push(`${fmtShort(s.since)} ${s.since.slice(0, 4)} to ${fmtShort(last.date)} ${last.date.slice(0, 4)}: ${parts.join(', ')}.`);
    }
    const added = p.readings.filter((r) => !(was?.readings ?? []).some((x) => x.date === r.date)).length;
    if (added) lines.push(`${added} balance${added === 1 ? '' : 's'} added to its history of gains and losses.`);
  } else if (p.kind === 'statement') {
    const was = debtOf(before, p.debtId);
    const now = debtOf(after, p.debtId)!;
    if (p.newDebt) lines.push(`New debt: ${p.newDebt.name}, paid from your payday split.`);
    lines.push(`${now.name}: ${was ? `${cash(owed(was))} → ` : ''}${cash(owed(now))} owed${p.inCredit ? ' (in credit)' : ''}`);
    const asOf = p.date <= today ? p.date : today;
    if (asOf < today && owed(now) !== p.balance) {
      explain.push(`The statement says ${cash(p.balance)} on ${fmtShort(asOf)}. Payments planned since then count as paid, so what’s owed today is ${cash(owed(now))}.`);
    }
    if (p.limit !== undefined && p.limit !== was?.limit) lines.push(`Credit limit: ${was?.limit ? `${cash(was.limit)} → ` : ''}${cash(p.limit)}`);
    for (const u of p.plans) {
      const a = was?.plans.find((x) => x.id === u.planId);
      const z = now.plans.find((x) => x.id === u.planId);
      const name = a?.name ?? z?.name ?? 'A plan';
      lines.push(`${name}: ${a ? `${cash(a.remaining)} → ` : ''}${cash(z?.remaining ?? 0)} left${z && (z.type === 'interest-free' || z.type === 'equal') ? `, interest-free until ${fmtShort(planEnds(z))}` : ''}${z ? '' : ' (now paid off)'}`);
    }
    for (const np of p.newPlans) {
      const z = now.plans.find((x) => x.id === np.id);
      lines.push(`New plan: ${np.name}, ${cash(z?.remaining ?? np.remaining)} left, interest-free until ${fmtShort(np.ends!)}`);
    }
  } else if (p.kind === 'balances') {
    for (const x of p.set) {
      const name = after.accounts.find((a) => a.id === x.accountId)?.name ?? 'An account';
      const prev = before.balances?.[x.accountId];
      lines.push(`${name}: balance ${prev && prev.amount !== x.amount ? `${cash(prev.amount)} → ` : ''}${cash(x.amount)}${prev?.amount === x.amount ? ' (no change)' : ''}, as at ${fmtShort(p.asOf)}`);
    }
  } else if (p.kind === 'transactions') {
    const isDebt = p.target.type === 'debt';
    const was = isDebt ? debtOf(before, p.target.id) : undefined;
    const now = isDebt ? debtOf(after, p.target.id) : undefined;
    const name = (isDebt ? now?.name : after.accounts.find((a) => a.id === p.target.id)?.name) ?? 'It';
    if (p.add.length) lines.push(`${name}: ${p.add.length} transaction${p.add.length === 1 ? '' : 's'} saved, ${fmtSpan(p.add[0].date, p.add[p.add.length - 1].date)}.`);
    if (was && now && p.balance) {
      lines.push(`${name}: ${cash(owed(was))} → ${cash(owed(now))} owed`);
      if (p.balance.asOf < today && owed(now) !== p.balance.amount) explain.push(`That’s ${cash(p.balance.amount)} on ${fmtShort(p.balance.asOf)}. Payments planned since then count as paid, so what’s owed today is ${cash(owed(now))}.`);
    }
    if (!isDebt && p.balance) {
      const prev = before.balances?.[p.target.id];
      lines.push(`${name}: balance ${prev ? `${cash(prev.amount)} → ` : ''}${cash(p.balance.amount)}, as at ${fmtShort(p.balance.asOf)}`);
    }
    const firstKnown = was?.history?.[0]?.asOf;
    const back = isDebt ? p.history.filter((h) => !firstKnown || h.asOf < firstKnown).length : 0;
    if (back) lines.push(`${name}: what was owed on ${back} earlier day${back === 1 ? '' : 's'} added to its history.`);
    const knownBefore = isDebt ? was?.ending : before.accounts.find((a) => a.id === p.target.id)?.ending;
    if (p.ending && !knownBefore) lines.push(`Next time, an export with number ending ${p.ending} goes to ${name} straight away.`);
  } else {
    const was = debtOf(before, p.debtId)!;
    const now = debtOf(after, p.debtId)!;
    const left = (xs?: { date: ISODate; amount: Cents }[]) => (xs ?? []).length;
    for (const u of p.updates) {
      const a = was.plans.find((x) => x.id === u.planId)!;
      const z = now.plans.find((x) => x.id === u.planId);
      const same = JSON.stringify(a.instalments ?? []) === JSON.stringify(u.instalments);
      lines.push(`${a.name}: ${same ? 'no change' : `${left(a.instalments) || '?'} instalment${left(a.instalments) === 1 ? '' : 's'} left, ${cash(a.remaining)} → ${left(z?.instalments)} left, ${cash(z?.remaining ?? 0)}`}${u.instalments[0] ? `, next ${cash(u.instalments[0].amount)} on ${fmtShort(u.instalments[0].date)}` : ''}`);
    }
    for (const id of p.paidOff) lines.push(`${was.plans.find((x) => x.id === id)?.name ?? 'An order'}: paid off, taken off the list.`);
    for (const np of p.newPlans) lines.push(`New order: ${np.name}, ${cash(np.remaining)} in ${np.instalments!.length} instalment${np.instalments!.length === 1 ? '' : 's'}, next ${cash(np.instalments![0].amount)} on ${fmtShort(np.instalments![0].date)}`);
    if (owed(was) !== owed(now)) lines.push(`${now.name} altogether: ${cash(owed(was))} → ${cash(owed(now))} owed`);
  }

  // Every change re-balances the next 12 pays: list each account whose payday amount moves.
  const byAccount = new Map<string, PayChange>();
  let count = 0;
  for (const per of autoPays(after, today)) {
    const a = planFor(before, per, today);
    const z = planFor(after, per, today);
    for (const acc of z.accounts) {
      const from = a.accounts.find((x) => x.account.id === acc.account.id)?.funded ?? 0;
      if (from === acc.funded) continue;
      count++;
      const c = byAccount.get(acc.account.id);
      if (c) c.pays++;
      else byAccount.set(acc.account.id, { account: acc.account.name, pays: 1, first: { date: per.start, from, to: acc.funded } });
    }
  }
  return { after, lines, explain, payChanges: [...byAccount.values()], payChangeCount: count, payStart };
}

/** A short, stable summary of a preview, to tell whether it changed between showing it and Confirm. */
export function fingerprint(pv: Preview): string {
  return JSON.stringify([pv.lines, pv.explain, pv.payChanges]);
}


import { nextColor } from '../colors';
import { fmtDay, fmtShort, monthName, type ISODate } from '../dates';
import { debtPerPay, exactForFirstPlan, owed, planEnds, recordHistory, settleDue } from '../debts';
import { recordPayslip } from '../documents';
import { paydayFor, planFor, recordPayday } from '../engine';
import { cash } from '../money';
import { autoBalance, autoPays } from '../rebalance';
import type { Budget, Cents, Debt, PaidPayment } from '../types';
import type { Proposal } from './check';

// ---------------------------------------------------------------------------------------------
// Applying a checked Proposal. applyProposal is a plain function on a budget, so it runs first on a
// copy (for the rundown and Undo) and then, unchanged, inside store.update(). Savings goals, deposits
// and account balances are never edited here: they only move when the next 12 pays rebalance.
// ---------------------------------------------------------------------------------------------

export function applyProposal(b: Budget, p: Proposal, today: ISODate): Budget {
  if (p.kind === 'payslip') { recordPayslip(b, p.slip); return b; }
  if (p.kind === 'statement') {
    if (p.newDebt) addDebt(b, p.debtId, p.newDebt.name);
    applyStatement(b, p.debtId, p, today);
    return b;
  }
  const debt = (b.debts ?? []).find((d) => d.id === p.debtId);
  if (!debt) return b;
  for (const u of p.updates) {
    const plan = debt.plans.find((x) => x.id === u.planId);
    if (!plan) continue;
    // The screenshot's instalments replace the ones saved: never added on top.
    plan.instalments = u.instalments.map((i) => ({ ...i }));
    plan.remaining = u.instalments.reduce((t, i) => t + i.amount, 0);
    plan.asOf = today;
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
  if (s.limit !== undefined && s.limit > 0) debt.limit = s.limit;
  for (const u of s.plans) {
    const plan = debt.plans.find((x) => x.id === u.planId);
    if (!plan) continue;
    plan.remaining = u.remaining;
    plan.asOf = asOf;
    if (u.ends) plan.ends = u.ends;
  }
  for (const np of s.newPlans) {
    if (debt.plans.some((x) => x.id === np.id)) continue;
    debt.plans.push({ ...structuredClone(np), asOf, purchaseDate: np.purchaseDate > asOf ? asOf : np.purchaseDate });
    exactForFirstPlan(b, debt);
  }
  const hist = (debt.history ?? []).filter((h) => h.asOf !== asOf);
  hist.push({ amount: owed(debt), asOf });
  debt.history = hist.sort((x, y) => x.asOf.localeCompare(y.asOf)).slice(-500);
  if (asOf < today) settleDue(debt, b.settings, today, debtPerPay(b, debt));
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


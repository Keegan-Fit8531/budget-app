import { ordinal, todayISO, type ISODate } from '../core/dates';
import { balanceOn } from './balances/estimate';
import { depositFor } from './balances/deposits';
import { exactNeed, modeOf } from './balances/outflows';
import { freezePaySplit } from './balances/freeze';
import { topsUp } from './balances/topUps';
import { accountHasPlans, debtPaymentsIn, heldDebtPaymentsIn, isHoldDisplayAccount } from '../features/debts/logic/funding';
import { accountHasGoals, savingsNeedIn } from '../features/savings/logic/savings';
import type { Account, Budget, Cents, Item } from '../core/types';
import { type Period, periodContaining, upcomingPayPeriod, shiftPeriod } from './periods';
import { isHeldInAccount, setAsidesOn, envelopesOn } from './setAside';
import { itemDates } from './occurrences';
import { convert } from './frequency';

// ---------- Period plan ----------

export interface Due { item: Item; date: ISODate }

export interface AccountPlan {
  account: Account;
  /** What payday sends in this period. */
  funded: Cents;
  /** What the account's items take out during this period. */
  need: Cents;
  /** funded − need (positive = spare). Null when the account has no items (e.g. an external payment). */
  diff: Cents | null;
  /** Estimated balance at the end of the period, when you've entered a balance for the account. */
  endBalance?: Cents;
  /** Set when this pay's amount was adjusted for this pay only (e.g. by Balance this pay). */
  usual?: Cents;
  dues: Due[];
  /** Explanation like "5 × $200 weekly". */
  breakdown: { item: Item; count: number }[];
}

export interface PeriodPlan {
  period: Period;
  pay: Cents;
  payIsActual: boolean;
  /** When there's no payslip yet: the period whose actual pay is used as the estimate. */
  payEstimateFrom?: ISODate;
  totalSplit: Cents;
  leftover: Cents;
  accounts: AccountPlan[];
  dues: Due[];
}

export function isAuto(b: Budget, accountId: string): boolean {
  return modeOf(b.split.find((l) => l.accountId === accountId)) !== 'fixed';
}

export function planFor(b: Budget, period: Period, today: ISODate = todayISO()): PeriodPlan {
  const actual = b.payActuals[period.start];
  // No payslip for this period yet: plan with the most recent pay received before it.
  const prevKey = actual === undefined ? Object.keys(b.payActuals).filter((k) => k < period.start).sort().pop() : undefined;
  const pay = actual ?? (prevKey ? b.payActuals[prevKey] : b.settings.expectedPay);
  // Once this pay is locked (payslip in / payday passed), freeze the split so later changes don’t rewrite it.
  freezePaySplit(b, period, today);
  const live = b.accounts.filter((a) => !a.archived);
  const payId = b.settings.payAccountId;

  // First work out what each account's costs need this period…
  const allDues: Due[] = [];
  const base = live.map((account) => {
    const items = b.items.filter((i) => i.accountId === account.id);
    const dues: Due[] = [];
    const breakdown = items.filter((i) => !isHeldInAccount(i)).map((item) => {
      const dates = itemDates(item, period.start, period.end, b.settings);
      dates.forEach((date) => dues.push({ item, date }));
      return { item, count: dates.length };
    }).filter((x) => x.count > 0);
    // Debt plan payments and savings goals linked to this account count as its costs too.
    // Held-elsewhere debts (Gem in Misc bills) still list their payments on the debt card for display.
    const debtPays = isHoldDisplayAccount(b, account.id)
      ? heldDebtPaymentsIn(b, account.id, period.start, period.end)
      : debtPaymentsIn(b, account.id, period.start, period.end);
    for (const p of debtPays) {
      // Hold account (e.g. Misc bills): list under that account's costs as the debt (Gem Visa), with a note.
      // Debt's own display account: keep plan names so opening Gem still shows what the payment covers.
      const heldHere = !!p.debt.holdAccountId && p.debt.holdAccountId === account.id;
      const item: Item = {
        id: `${p.plan.id}@${p.date}`,
        name: heldHere ? p.debt.name : p.plan.name,
        amount: p.amount,
        frequency: 'once',
        start: p.date,
        accountId: account.id,
        ...(heldHere
          ? {
              note: [
                p.debt.statementDay ? `Stored until the ${ordinal(p.debt.statementDay)}` : 'Stored until statement day',
                `set on ${p.debt.name}`,
                p.plan.name !== p.debt.name ? p.plan.name : undefined,
              ].filter(Boolean).join(' · '),
            }
          : {}),
      };
      dues.push({ item, date: p.date });
      breakdown.push({ item, count: 1 });
    }
    const saving = savingsNeedIn(b, account.id, period.start);
    if (saving > 0) {
      const item: Item = { id: `save-${account.id}`, name: 'Savings goal', amount: saving, frequency: 'once', start: period.start, accountId: account.id };
      dues.push({ item, date: period.start });
      breakdown.push({ item, count: 1 });
    }
    // Money put aside on payday (a WOF, tyres): part of what the account needs, though nothing is paid out.
    for (const x of setAsidesOn(b, account.id, period.start, { today })) {
      if (x.amount <= 0) continue;
      const item: Item = { ...x.item, id: `aside-${x.item.id}`, amount: x.amount, frequency: 'once', start: period.start, end: undefined, setAside: true };
      dues.push({ item, date: period.start });
      breakdown.push({ item, count: 1 });
    }
    // Envelopes (Gas $200/month, Food $200/week): what this payday funds, spent from synced purchases.
    for (const x of envelopesOn(b, account.id, period.start)) {
      if (x.amount <= 0) continue;
      const item: Item = { ...x.item, id: `env-${x.item.id}`, amount: x.amount, frequency: 'once', start: period.start, end: undefined };
      dues.push({ item, date: period.start });
      breakdown.push({ item, count: 1 });
    }
    dues.sort((x, y) => x.date.localeCompare(y.date));
    // The pay's list of payments leaves out what's only put aside or held in a month envelope.
    allDues.push(...dues.filter((d) => !isHeldInAccount(d.item)));
    const need = dues.reduce((s, d) => s + d.item.amount, 0);
    // …then what payday sends: the same amount the balance projections use (one source of truth).
    const funded = account.id === payId ? 0 : depositFor(b, account.id, period, today);
    const hasCosts = items.length > 0 || accountHasPlans(b, account.id) || accountHasGoals(b, account.id)
      || isHoldDisplayAccount(b, account.id);
    return { account, items, dues, breakdown, need, funded, hasCosts };
  });

  // Debts that store their payment in another account (e.g. Gem → Misc bills) still show a funded
  // amount on the debt card, but that money is already in the hold account's deposit — don't count twice.
  const totalSplit = base.filter((x) => x.account.id !== payId && !isHoldDisplayAccount(b, x.account.id))
    .reduce((s, x) => s + x.funded, 0);
  const leftover = pay - totalSplit;

  const accounts = base.map(({ account, dues, breakdown, need, funded, hasCosts }): AccountPlan => {
    const f = account.id === payId ? leftover : funded;
    // With a balance entered, "short" means the account would actually go below $0 by the period's end.
    // Steady, or exact that tops up, with no balance entered: what it's projected to hold by then.
    const entry = b.balances?.[account.id];
    const tracked = account.id !== payId && (entry ? account.kind === 'bank'
      : modeOf(b.split.find((l) => l.accountId === account.id)) === 'smooth' || topsUp(b, account.id));
    const endBalance = tracked ? balanceOn(b, account.id, period.end, today) : undefined;
    // A one-pay adjustment to a debt changes what's paid, not what's "due", so don't call it short.
    const isDebt = (b.debts ?? []).some((d) => d.accountId === account.id);
    const adjusted = b.overrides?.[period.start]?.[account.id] !== undefined;
    const diff = endBalance !== undefined ? endBalance : adjusted && isDebt ? null : hasCosts ? f - need : null;
    return { account, funded: f, need, diff, endBalance, dues, breakdown, usual: adjusted ? depositFor(b, account.id, period, today, { usual: true }) : undefined };
  });
  allDues.sort((x, y) => x.date.localeCompare(y.date));
  return { period, pay, payIsActual: actual !== undefined, payEstimateFrom: prevKey, totalSplit, leftover, accounts, dues: allDues };
}

/**
 * What payday sends to accounts in all, in the view's terms (`sentOf`: this pay's `funded`, or an average).
 * Leaves out the pay account, and a debt held in another account (Gem in Misc bills), whose money is
 * already in that account's send. The same rule as `PeriodPlan.totalSplit`.
 */
export function sendsTotal(b: Budget, accounts: AccountPlan[], sentOf: (a: AccountPlan) => Cents): Cents {
  return accounts.filter((a) => a.account.id !== b.settings.payAccountId && !isHoldDisplayAccount(b, a.account.id))
    .reduce((t, a) => t + sentOf(a), 0);
}

/**
 * Each account's part of a pay as charts and lists show it (not the pay account; nothing below $0). A held
 * debt (Gem in Misc bills) shows as its own amount, taken out of the account holding it, so it's counted once.
 */
export function splitShown(b: Budget, accounts: AccountPlan[], sentOf: (a: AccountPlan) => Cents): Map<string, Cents> {
  const rows = accounts.filter((a) => a.account.id !== b.settings.payAccountId);
  const holdOut = new Map<string, Cents>();
  for (const a of rows) {
    if (!isHoldDisplayAccount(b, a.account.id)) continue;
    const holds = new Set((b.debts ?? []).filter((d) => d.accountId === a.account.id && d.holdAccountId).map((d) => d.holdAccountId!));
    for (const h of holds) holdOut.set(h, (holdOut.get(h) ?? 0) + Math.max(0, sentOf(a)));
  }
  return new Map(rows.map((a) => [a.account.id, Math.max(0, sentOf(a) - (holdOut.get(a.account.id) ?? 0))]));
}

/** Steady per-pay amount for an account: its items' long-run monthly average. */
export function averageNeed(b: Budget, accountId: string): Cents {
  const mine = b.items.filter((i) => i.accountId === accountId && i.frequency !== 'once');
  let items = mine.filter((i) => !i.skipIfWithin || isHeldInAccount(i)).reduce((s, i) => s + convert(i.amount, i.frequency, 'month'), 0);
  // Costs with a skip-near-payday rule: count the real dates over the next 12 pays. (Held-in-account
  // costs never skip: the line above counts each at its average per month.)
  const skippy = mine.filter((i) => i.skipIfWithin && !isHeldInAccount(i));
  if (skippy.length) {
    const first = periodContaining(todayISO(), b.settings);
    const last = shiftPeriod(first, 11, b.settings);
    const total = skippy.reduce((s, i) => s + i.amount * itemDates(i, first.start, last.end, b.settings).length, 0);
    items += Math.round(total / 12);
  }
  // Debts: average of the next 12 pays' plan payments. Savings: the per-pay amount goals need.
  let extra = 0;
  // (A card balance with no payment plans still gets paid off, e.g. a Mastercard balance.)
  const hasDebt = (b.debts ?? []).some((d) => (d.accountId === accountId || d.holdAccountId === accountId) && !d.payroll);
  if (hasDebt || accountHasPlans(b, accountId) || accountHasGoals(b, accountId)) {
    let p = periodContaining(todayISO(), b.settings);
    let total = 0;
    for (let i = 0; i < 12; i++) {
      total += debtPaymentsIn(b, accountId, p.start, p.end, { usual: true }).reduce((s, x) => s + x.amount, 0);
      total += heldDebtPaymentsIn(b, accountId, p.start, p.end, { usual: true }).reduce((s, x) => s + x.amount, 0);
      total += savingsNeedIn(b, accountId, p.start);
      p = shiftPeriod(p, 1, b.settings);
    }
    extra = Math.round(total / 12);
  }
  return items + extra;
}

/** What payday sends to an account on average per month (auto accounts use their average need). */
export function averageSplit(b: Budget, accountId: string): Cents {
  const line = b.split.find((l) => l.accountId === accountId);
  if (!line) return 0;
  const mode = modeOf(line);
  // Steady: its usual amount (not the next pay's, which can include a one-off catch-up).
  return mode === 'exact' ? averageNeed(b, accountId) : mode === 'smooth' ? averageNeed(b, accountId) : line.amount;
}

/**
 * Per pay (≈ per month), averaged over the next 12 pays: what's planned to be sent to an account and what
 * its costs take. Counts everything that's really planned: catch-ups, one-pay adjustments, goals that
 * stop at their date, debts that get paid off. Used by the Week / Fortnight / Month avg / Year views.
 */
export function plannedAverage(b: Budget, accountId: string, today: ISODate = todayISO()): { sent: Cents; need: Cents } {
  let p = upcomingPayPeriod(b, today);
  let sent = 0, need = 0;
  for (let i = 0; i < 12; i++) {
    sent += depositFor(b, accountId, p, today);
    need += exactNeed(b, accountId, p);
    p = shiftPeriod(p, 1, b.settings);
  }
  return { sent: Math.round(sent / 12), need: Math.round(need / 12) };
}

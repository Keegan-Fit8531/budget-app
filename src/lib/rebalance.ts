import { accountMode, levelAmount, spareInfo } from './balances';
import { fmtShort } from './dates';
import { debtAdvice } from './debts';
import { todayISO } from './dates';
import { planFor, shiftPeriod, upcomingPayPeriod, type Period } from './engine';
import type { ISODate } from './dates';
import type { Budget, Cents } from './types';

export interface BalanceChange {
  accountId: string;
  name: string;
  from: Cents;
  to: Cents;
  reason: string;
  /** true when this pay sends more to the account (it was short), false when it's a trim. */
  topUp?: boolean;
}

export interface BalanceResult {
  changes: BalanceChange[];
  /**
   * Accounts whose payday amount is changed as part of balancing: weekly costs → Steady (no ups and downs
   * between 4- and 5-week pays); bills on a fixed amount → Exact (sends what the bills need, less what's left).
   */
  toSteady: { accountId: string; name: string; was: 'fixed' | 'exact'; to: 'smooth' | 'exact' }[];
  /** Left after the plan, before and after balancing. */
  before: Cents;
  after: Cents;
  /** Still short after every safe cut (0 when balanced). */
  stillShort: Cents;
  /** Accounts checked for spare money that had none to give, and why. */
  notSpare: { accountId: string; name: string; reason: string }[];
  /** Accounts that can't cover their costs this pay, and by how much. */
  shortAccounts: { accountId: string; name: string; short: Cents }[];
  /** Debt repayments as a share of this pay, before and after. */
  debtRatio: { before: number; after: number };
}

/** Guideline: keep consumer-debt repayments (excluding rent/mortgage) under 20% of take-home pay. */
export const DEBT_RATIO_GUIDE = 0.2;

const dollarsUp = (c: Cents) => Math.ceil(c / 100) * 100;

/**
 * Work out one-pay changes that bring a short pay back to $0 or better, in best-practice order:
 *  0. Top up any account that would run short.
 *  1. Spare money already sitting in an account (balance entered, keeps a payment in reserve).
 *  2. Debt paid above what's needed on 0% / interest-free plans (no interest is saved by paying early).
 *  3. Savings contributions (largest first) — they can catch up next pay.
 *  4. Sinking funds (set-asides for later costs).
 * Never cut: rent, bills, food and gas, weekly transfers, or any debt's required payment.
 */
/** `keep`: accounts with an amount you set yourself this pay; never trimmed or changed (except a top-up if it's short). */
export function balancePay(input: Budget, period: Period, keep: Set<string> = new Set()): BalanceResult {
  // Even out first: accounts with weekly costs that aren't on Steady go up and down between 4- and
  // 5-week pays, so balancing moves them to Steady (and works everything else out from there).
  const items = (id: string) => input.items.filter((i) => i.accountId === id);
  const allWeekly = (id: string) => items(id).length > 0 && items(id).every((i) => i.frequency === 'weekly');
  const setAside = (id: string) => items(id).length > 0 && items(id).every((i) => /set.?aside/i.test(`${i.name} ${i.note ?? ''}`));
  const usable = (a: Budget['accounts'][number]) => !a.archived && a.kind === 'bank' && a.id !== input.settings.payAccountId
    && input.overrides?.[period.start]?.[a.id] === undefined && !(input.savings ?? []).some((g) => g.accountId === a.id)
    && !(input.debts ?? []).some((d) => d.accountId === a.id);
  const toSteady: BalanceResult['toSteady'] = [
    // Only accounts whose costs are all weekly transfers (food and gas, allowance) go to Steady.
    ...input.accounts.filter((a) => usable(a) && accountMode(input, a.id) !== 'smooth' && allWeekly(a.id))
      .map((a) => ({ accountId: a.id, name: a.name, was: accountMode(input, a.id) as 'fixed' | 'exact', to: 'smooth' as const })),
    // Accounts with bills on set dates (even with a weekly cost among them, e.g. a bills account) go to Exact.
    ...input.accounts.filter((a) => usable(a) && accountMode(input, a.id) === 'fixed' && items(a.id).length > 0 && !allWeekly(a.id) && !setAside(a.id))
      .map((a) => ({ accountId: a.id, name: a.name, was: 'fixed' as const, to: 'exact' as const })),
  ];
  const b = toSteady.length ? structuredClone(input) : input;
  for (const t of toSteady) {
    const l = b.split.find((x) => x.accountId === t.accountId);
    if (l) { l.mode = t.to; delete l.auto; } else b.split.push({ accountId: t.accountId, amount: 0, mode: t.to });
  }
  const plan = planFor(b, period);
  const debts = b.debts ?? [];
  const debtIds = new Set(debts.map((d) => d.accountId));
  const funded = (id: string) => plan.accounts.find((a) => a.account.id === id)?.funded ?? 0;
  const debtPaid = (changes: BalanceChange[]) => [...debtIds].reduce((t, id) => t + (changes.find((c) => c.accountId === id)?.to ?? funded(id)), 0);
  const ratio = (paid: Cents) => (plan.pay > 0 ? paid / plan.pay : 0);

  // Accounts that would run short this pay (not debts: their "due" is handled by recommendations).
  const shortAccounts = plan.accounts
    .filter((a) => a.account.id !== b.settings.payAccountId && !debtIds.has(a.account.id) && a.diff !== null && a.diff < 0)
    .map((a) => ({ accountId: a.account.id, name: a.account.name, short: -(a.diff ?? 0) }));

  const changes: BalanceChange[] = [];
  const notSpare: BalanceResult['notSpare'] = [];
  // 0. Top up short accounts first — their costs are real (e.g. a Wednesday transfer before payday).
  for (const s of shortAccounts) {
    const from = funded(s.accountId);
    changes.push({ accountId: s.accountId, name: s.name, from, to: from + s.short, topUp: true, reason: `Needs ${fmt(s.short)} more to cover its costs before next payday.` });
  }
  const topUps = shortAccounts.reduce((t, s) => t + s.short, 0);
  let short = topUps - plan.leftover;
  const protectedIds = new Set(shortAccounts.map((s) => s.accountId));
  const cut = (accountId: string, name: string, amount: Cents, reason: string) => {
    if (short <= 0 || amount <= 0 || protectedIds.has(accountId) || keep.has(accountId)) return;
    const from = funded(accountId);
    const take = Math.min(amount, dollarsUp(short), from);
    if (take <= 0) return;
    changes.push({ accountId, name, from, to: from - take, reason });
    short -= take;
  };

  if (short > 0) {
    // 1. Spare money already in an account (balance entered): send less to it this pay.
    const savingGroupIds = new Set(b.groups.filter((g) => g.bucket === 'savings').map((g) => g.id));
    for (const a of plan.accounts) {
      const id = a.account.id;
      if (id === b.settings.payAccountId || debtIds.has(id) || a.account.kind !== 'bank' || savingGroupIds.has(a.account.groupId)) continue;
      if (!b.items.some((i) => i.accountId === id)) continue;
      const name = a.account.name;
      const info = spareInfo(b, id, period);
      if (!info) { notSpare.push({ accountId: id, name, reason: 'No balance entered in Accounts, so the app can\u2019t tell if it has spare money.' }); continue; }
      if (protectedIds.has(id)) { notSpare.push({ accountId: id, name, reason: 'It\u2019s short this pay, so it was topped up instead.' }); continue; }
      const spare = info.spare;
      if (spare <= 0) {
        // Steady accounts (e.g. rent) build a buffer for pays with an extra week: that money is spoken for.
        if (accountMode(b, id) === 'smooth') { notSpare.push({ accountId: id, name, reason: `Its balance is the buffer for pays with an extra week (e.g. 5 rent Mondays). Over the next 12 pays it drops to ${fmt(info.low)} (${fmtShort(info.lowAt)}), so none of it is spare.` }); continue; }
        notSpare.push({ accountId: id, name, reason: `Its lowest point over the next 12 pays is ${fmt(info.low)} (${fmtShort(info.lowAt)}), which isn't more than the ${fmt(info.reserve)} it keeps in reserve.` });
        continue;
      }
      if (spare > 0) {
        cut(id, a.account.name, spare,
          `Already has more in it than it needs: even sending less this pay, it keeps at least one payment spare over the next 12 pays.`);
      }
    }
    // 2. Debt overpayments with no interest benefit.
    for (const d of debts) {
      if (d.payroll) continue; // taken from salary, nothing to trim
      const adv = debtAdvice(b, d, period);
      const interestFree = d.rules === 'gem' || d.kind === 'bnpl' || !d.rate;
      const extra = funded(d.accountId) - adv.recommended;
      if (interestFree && extra > 0) {
        cut(d.accountId, d.name, extra,
          `Paying more than ${fmt(adv.recommended)} saves no interest: ${d.rules === 'gem' ? 'every Gem plan still clears before it expires' : 'it’s interest-free'}.`);
      }
    }
    // 3. Savings contributions, largest first (not debts).
    const savingGroups = new Set(b.groups.filter((g) => g.bucket === 'savings').map((g) => g.id));
    const savers = plan.accounts
      .filter((a) => !debtIds.has(a.account.id) && savingGroups.has(a.account.groupId) && a.funded > 0)
      .sort((x, y) => y.funded - x.funded);
    for (const a of savers) cut(a.account.id, a.account.name, a.funded, 'Saved a bit less this pay only. It can catch up next pay.');
    // 4. Sinking funds: accounts whose costs are all set-asides for later.
    const sinking = plan.accounts.filter((a) => {
      const items = b.items.filter((i) => i.accountId === a.account.id);
      return items.length > 0 && items.every((i) => /set.?aside/i.test(`${i.name} ${i.note ?? ''}`)) && a.funded > 0;
    });
    for (const a of sinking) cut(a.account.id, a.account.name, a.funded, 'Set-aside for later costs, paused this pay. Top it up next pay.');
  }

  // 5. With money left over: put a little aside in Steady accounts for the next 5-week pay, so later pays
  //    all stay at the usual amount (instead of that pay going up). Never trims anything else for this.
  let spare = plan.leftover + changes.reduce((t, c) => t + (c.from - c.to), 0);
  for (const a of plan.accounts) {
    if (spare <= 0) break;
    const id = a.account.id;
    if (id === b.settings.payAccountId || accountMode(b, id) !== 'smooth' || changes.some((c) => c.accountId === id) || keep.has(id)) continue;
    if (!allWeekly(id)) continue;
    const level = levelAmount(b, id, period);
    if (level === undefined || level <= a.funded) continue;
    const add = Math.min(level - a.funded, Math.floor(spare / 100) * 100);
    if (add <= 0) continue;
    changes.push({ accountId: id, name: a.account.name, from: a.funded, to: a.funded + add, topUp: true,
      reason: `Puts ${fmt(add)} aside for the next 5-week pay, so every pay after this stays at the usual amount.` });
    spare -= add;
  }

  const net = changes.reduce((t, c) => t + (c.from - c.to), 0); // trims minus top-ups
  return {
    changes,
    toSteady,
    before: plan.leftover,
    after: plan.leftover + net,
    stillShort: Math.max(0, -(plan.leftover + net)),
    shortAccounts,
    notSpare,
    debtRatio: { before: ratio(debtPaid([])), after: ratio(debtPaid(changes)) },
  };
}

/** Apply a result: one-pay adjustments, and any accounts moved to Steady. Returns the previous adjustments. */
export function applyBalance(b: Budget, period: Period, r: BalanceResult): Record<string, Cents> | undefined {
  const previous = b.overrides?.[period.start] ? { ...b.overrides[period.start] } : undefined;
  b.overrides = b.overrides ?? {};
  const o = { ...(b.overrides[period.start] ?? {}) };
  for (const c of r.changes) o[c.accountId] = c.to;
  b.overrides[period.start] = o;
  for (const t of r.toSteady ?? []) {
    const l = b.split.find((x) => x.accountId === t.accountId);
    if (l) { l.mode = t.to ?? 'smooth'; delete l.auto; } else b.split.push({ accountId: t.accountId, amount: 0, mode: t.to ?? 'smooth' });
  }
  return previous;
}

/** Put a pay's adjustments back to what they were (undefined = none). */
export function restoreOverrides(b: Budget, periodStart: string, previous: Record<string, Cents> | undefined): void {
  b.overrides = b.overrides ?? {};
  if (previous) b.overrides[periodStart] = previous; else delete b.overrides[periodStart];
}

const fmt = (c: Cents) => `$${(c / 100).toLocaleString('en-NZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** How many upcoming pays automatic balancing looks after. */
export const AUTO_PAYS = 12;

export const autoBalanceOn = (b: Budget) => b.settings.autoBalance !== false;

/** The pays automatic balancing covers: from the next payday on (a pay already split is left as it is). */
export function autoPays(b: Budget, today: ISODate = todayISO()): Period[] {
  const out: Period[] = [];
  let p = upcomingPayPeriod(b, today);
  for (let i = 0; i < AUTO_PAYS; i++) { out.push(p); p = shiftPeriod(p, 1, b.settings); }
  return out;
}

/** Undo what automatic balancing set for a pay (anything you've changed since is kept). */
export function clearAuto(b: Budget, start: ISODate): void {
  const mine = b.autoBalanced?.[start];
  if (!mine) return;
  const o = { ...(b.overrides?.[start] ?? {}) };
  for (const [id, x] of Object.entries(mine)) {
    if (o[id] !== x.to) continue; // you changed it since: yours now
    if (x.prev === null) delete o[id]; else o[id] = x.prev;
  }
  b.overrides = b.overrides ?? {};
  if (Object.keys(o).length) b.overrides[start] = o; else delete b.overrides[start];
  delete b.autoBalanced![start];
}

/**
 * Balance every upcoming pay, in order, from scratch: what it set last time is undone first, so a pay
 * that no longer needs a trim gets its normal amount back. Changes you made yourself are built on.
 * Same inputs give the same result, so it's safe to run after every change.
 */
export function autoBalance(b: Budget, today: ISODate = todayISO()): Budget {
  if (!autoBalanceOn(b)) return b;
  b.autoBalanced = b.autoBalanced ?? {};
  for (const p of autoPays(b, today)) {
    clearAuto(b, p.start);
    // Whatever is still adjusted now is yours: balancing builds around it.
    const r = balancePay(b, p, new Set(Object.keys(b.overrides?.[p.start] ?? {})));
    if (!r.changes.length && !r.toSteady.length) continue;
    const before = b.overrides?.[p.start] ?? {};
    const mine: NonNullable<Budget['autoBalanced']>[string] = {};
    for (const c of r.changes) mine[c.accountId] = { prev: before[c.accountId] ?? null, to: c.to, reason: c.reason };
    applyBalance(b, p, r);
    if (Object.keys(mine).length) b.autoBalanced[p.start] = mine;
  }
  return b;
}

/** Turn automatic balancing off: every upcoming pay goes back to its normal amounts. */
export function stopAutoBalance(b: Budget, today: ISODate = todayISO()): Budget {
  for (const p of autoPays(b, today)) clearAuto(b, p.start);
  b.settings.autoBalance = false;
  return b;
}

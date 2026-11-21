import { depositFor, paySplitLocked } from './balances';
import { owed } from './debts';
import { convert, isHeldInAccount, itemDates, planFor, type Period } from './engine';
import type { Budget, Cents, SplitLine } from './types';

/** Somewhere the money left over can go. */
export interface AllocTarget {
  id: string;
  kind: 'goal' | 'allowance' | 'debt' | 'spend';
  name: string;
  accountId?: string;
  /** Weekly cost that gets bigger when money goes to the allowance (e.g. the $200 Wednesday transfer). */
  weeklyItemId?: string;
  color: string;
  detail: string;
}

export type AllocMode = 'once' | 'every';

/** Where leftover money can go this pay: savings goals, the weekly allowance, debts, or spending. */
export function allocationTargets(b: Budget): AllocTarget[] {
  const out: AllocTarget[] = [];
  const acc = (id: string) => b.accounts.find((a) => a.id === id);
  for (const g of b.savings ?? []) {
    const a = acc(g.accountId);
    if (!a || a.archived) continue;
    out.push({ id: `goal-${g.id}`, kind: 'goal', name: g.name, accountId: a.id, color: a.color, detail: g.note ?? 'Savings goal' });
  }
  // Weekly allowance: the account that funds a weekly transfer in the 'wants' bucket.
  const wants = new Set(b.groups.filter((g) => g.bucket === 'wants').map((g) => g.id));
  for (const a of b.accounts.filter((x) => !x.archived && x.kind === 'bank' && wants.has(x.groupId) && x.id !== b.settings.payAccountId)) {
    const weekly = b.items.find((i) => i.accountId === a.id && i.frequency === 'weekly' && !isHeldInAccount(i));
    if (weekly) out.push({ id: `allow-${a.id}`, kind: 'allowance', name: 'Weekly allowance', accountId: a.id, weeklyItemId: weekly.id, color: a.color, detail: `${a.name} → ${weekly.name.toLowerCase()}` });
  }
  for (const d of b.debts ?? []) {
    if (owed(d) <= 0 || d.payroll) continue; // payroll-deducted (e.g. student loan): not from the split
    const a = acc(d.accountId);
    out.push({ id: `debt-${d.id}`, kind: 'debt', name: d.name, accountId: d.accountId, color: a?.color ?? '#999', detail: `Pay extra off ${d.name}` });
  }
  const pay = acc(b.settings.payAccountId);
  out.push({ id: 'spend', kind: 'spend', name: 'Keep as spending money', color: pay?.color ?? '#999', detail: `Stays in ${pay?.name ?? 'your main account'}` });
  return out;
}

/** What an amount to the allowance means per week: this pay (÷ its transfers) or every pay (÷ weeks in a month). */
export function allowancePerWeek(b: Budget, period: Period, t: AllocTarget, amount: Cents, mode: AllocMode): { perWeek: Cents; weeks: number } {
  const item = b.items.find((i) => i.id === t.weeklyItemId);
  if (!item) return { perWeek: 0, weeks: 0 };
  if (mode === 'every') {
    // A monthly amount spread over an average month of weeks (365.25-day years).
    const perWeek = Math.floor(amount / convert(1_000_000, 'weekly', 'month') * 1_000_000);
    return { perWeek, weeks: 0 };
  }
  const weeks = itemDates(item, period.start, period.end, b.settings).length;
  return { perWeek: weeks ? Math.floor(amount / weeks) : 0, weeks };
}

/**
 * What Optimise changed, so Undo puts back only that (anything you've changed since stays as it is).
 * null = there was nothing there before.
 */
export interface AllocationUndo {
  periodStart: string;
  overrides: Record<string, Cents | null>;
  split: Record<string, SplitLine | null>;
  items: Record<string, Cents>;
  /**
   * What this pay sends each account Optimise changed, before and after. If payday then splits the pay
   * and its frozen split keeps the `after` figure, Undo puts `before` back. (Older saves don't have it.)
   */
  sent?: Record<string, { before: Cents; after: Cents }>;
}

/**
 * Put leftover money where you chose.
 *  once  = this pay only (one-pay adjustments; e.g. Wedding gets $1,000 + $150 this pay).
 *  every = from now on, this pay included (raises normal amounts; the allowance's weekly transfer goes up).
 *          Once payday has split this pay its amounts are frozen, so this pay also gets a one-pay
 *          adjustment for the same extra: its leftover goes down just as it would have before payday.
 * Returns what's needed to undo it.
 */
export function applyAllocation(b: Budget, period: Period, allocs: { targetId: string; amount: Cents }[], mode: AllocMode): AllocationUndo {
  const undo: AllocationUndo = { periodStart: period.start, overrides: {}, split: {}, items: {}, sent: {} };
  const targets = allocationTargets(b);
  const plan = planFor(b, period);
  const fundedNow = (p: typeof plan, id: string) => p.accounts.find((x) => x.account.id === id)?.funded ?? 0;
  // Payday has already split this pay: raising the normal amounts no longer changes what it sends.
  const frozen = !!b.splitSent?.[period.start] && paySplitLocked(b, period);
  const touched = new Set<string>();
  /** Send `extra` more to an account this pay only, on top of what it gets now. */
  const addThisPay = (accountId: string, extra: Cents) => {
    b.overrides = b.overrides ?? {};
    const cur = b.overrides[period.start]?.[accountId];
    if (!(accountId in undo.overrides)) undo.overrides[accountId] = cur ?? null;
    b.overrides[period.start] = { ...(b.overrides[period.start] ?? {}), [accountId]: (cur ?? fundedNow(plan, accountId)) + extra };
  };
  for (const { targetId, amount } of allocs) {
    const t = targets.find((x) => x.id === targetId);
    if (!t || amount <= 0 || t.kind === 'spend' || !t.accountId) continue;
    touched.add(t.accountId);
    const a = plan.accounts.find((x) => x.account.id === t.accountId);
    if (mode === 'once') { addThisPay(t.accountId, amount); continue; }
    if (t.kind === 'allowance') {
      const item = b.items.find((i) => i.id === t.weeklyItemId);
      if (item) {
        const was = depositFor(b, t.accountId, period, undefined, { usual: true });
        if (!(item.id in undo.items)) undo.items[item.id] = item.amount;
        item.amount += allowancePerWeek(b, period, t, amount, 'every').perWeek;
        // Split pay: send what the bigger transfers add to this pay, as payday would have before it split.
        const more = depositFor(b, t.accountId, period, undefined, { usual: true }) - was;
        if (frozen && more > 0) addThisPay(t.accountId, more);
      }
      continue;
    }
    // Every pay: from the normal amount, not this pay's one-off adjustment.
    const line = b.split.find((l) => l.accountId === t.accountId);
    if (!(t.accountId in undo.split)) undo.split[t.accountId] = line ? structuredClone(line) : null;
    const usual = a ? (a.usual ?? a.funded) : 0;
    if (line) { line.mode = 'fixed'; line.amount = usual + amount; delete line.auto; }
    else b.split.push({ accountId: t.accountId, amount, mode: 'fixed' });
    if (frozen) addThisPay(t.accountId, amount);
  }
  const after = planFor(b, period);
  for (const id of touched) {
    const was = fundedNow(plan, id), now = fundedNow(after, id);
    if (was !== now) undo.sent![id] = { before: was, after: now };
  }
  return undo;
}

/** Put back what an allocation changed. */
export function undoAllocation(b: Budget, u: AllocationUndo): void {
  for (const [id, prev] of Object.entries(u.overrides)) {
    const o = { ...(b.overrides?.[u.periodStart] ?? {}) };
    if (prev === null) delete o[id]; else o[id] = prev;
    b.overrides = b.overrides ?? {};
    if (Object.keys(o).length) b.overrides[u.periodStart] = o; else delete b.overrides[u.periodStart];
  }
  for (const [id, prev] of Object.entries(u.split)) {
    const i = b.split.findIndex((l) => l.accountId === id);
    if (prev === null) { if (i >= 0) b.split.splice(i, 1); }
    else if (i >= 0) b.split[i] = prev; else b.split.push(prev);
  }
  for (const [id, amount] of Object.entries(u.items)) {
    const item = b.items.find((x) => x.id === id);
    if (item) item.amount = amount;
  }
  // Payday split the pay after Optimise, so the frozen split kept Optimise's amount: put back what this pay
  // sent before it. A frozen amount that's changed since stays as it is.
  const sent = b.splitSent?.[u.periodStart];
  for (const [id, { before, after }] of Object.entries(u.sent ?? {})) {
    if (sent?.[id] === after) sent[id] = before;
  }
}

/**
 * Extra already added for this pay only (e.g. $300 to Misc savings) to places Optimise can send money,
 * as an allocation, so Optimise can show it and hand it out again even without its own undo record.
 * Amounts automatic balancing set are left out: they're its, not yours.
 */
export function existingExtras(b: Budget, period: Period): (AllocationUndo & { allocs: { targetId: string; amount: Cents }[] }) | null {
  const o = b.overrides?.[period.start];
  if (!o) return null;
  const auto = b.autoBalanced?.[period.start] ?? {};
  const plan = planFor(b, period);
  const undo: AllocationUndo = { periodStart: period.start, overrides: {}, split: {}, items: {}, sent: {} };
  const allocs: { targetId: string; amount: Cents }[] = [];
  for (const t of allocationTargets(b)) {
    const id = t.accountId;
    if (!id || t.kind === 'spend' || o[id] === undefined || id in undo.overrides || auto[id]?.to === o[id]) continue;
    const usual = plan.accounts.find((a) => a.account.id === id)?.usual;
    if (usual === undefined || o[id] <= usual) continue;
    undo.overrides[id] = null;
    // If payday's frozen split holds the extra too, handing it out again puts that back to the usual amount.
    undo.sent![id] = { before: usual, after: o[id] };
    allocs.push({ targetId: t.id, amount: o[id] - usual });
  }
  return allocs.length ? { ...undo, allocs } : null;
}

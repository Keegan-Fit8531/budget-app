import { owed } from './debts';
import { convert, isSetAside, itemDates, planFor, type Period } from './engine';
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
    const weekly = b.items.find((i) => i.accountId === a.id && i.frequency === 'weekly' && !isSetAside(i));
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
}

/**
 * Put leftover money where you chose.
 *  once  = this pay only (one-pay adjustments; e.g. Wedding gets $1,000 + $150 this pay).
 *  every = from now on (raises normal amounts; the allowance's weekly transfer goes up).
 * Returns what's needed to undo it.
 */
export function applyAllocation(b: Budget, period: Period, allocs: { targetId: string; amount: Cents }[], mode: AllocMode): AllocationUndo {
  const undo: AllocationUndo = { periodStart: period.start, overrides: {}, split: {}, items: {} };
  const targets = allocationTargets(b);
  const plan = planFor(b, period);
  for (const { targetId, amount } of allocs) {
    const t = targets.find((x) => x.id === targetId);
    if (!t || amount <= 0 || t.kind === 'spend' || !t.accountId) continue;
    const a = plan.accounts.find((x) => x.account.id === t.accountId);
    if (mode === 'once') {
      b.overrides = b.overrides ?? {};
      const cur = b.overrides[period.start]?.[t.accountId];
      if (!(t.accountId in undo.overrides)) undo.overrides[t.accountId] = cur ?? null;
      b.overrides[period.start] = { ...(b.overrides[period.start] ?? {}), [t.accountId]: (cur ?? a?.funded ?? 0) + amount };
      continue;
    }
    if (t.kind === 'allowance') {
      const item = b.items.find((i) => i.id === t.weeklyItemId);
      if (item) {
        if (!(item.id in undo.items)) undo.items[item.id] = item.amount;
        item.amount += allowancePerWeek(b, period, t, amount, 'every').perWeek;
      }
      continue;
    }
    // Every pay: from the normal amount, not this pay's one-off adjustment.
    const line = b.split.find((l) => l.accountId === t.accountId);
    if (!(t.accountId in undo.split)) undo.split[t.accountId] = line ? structuredClone(line) : null;
    const usual = a ? (a.usual ?? a.funded) : 0;
    if (line) { line.mode = 'fixed'; line.amount = usual + amount; delete line.auto; }
    else b.split.push({ accountId: t.accountId, amount, mode: 'fixed' });
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
}

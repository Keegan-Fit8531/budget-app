import { addDays, diffDays, fmtShort, ordinal, todayISO, WEEKDAY_NAMES, weekday, type ISODate } from '../../../core/dates';
import { cash } from '../../../core/money';
import { itemDates } from '../../../engine/occurrences';
import { periodContaining } from '../../../engine/periods';
import { billTracker } from '../../../engine/balances/billTracker';
import { bankFed, businessDay, checkKey, matchBills, sameAmount, type BillMatch } from '../../../engine/billMatch';
import type { Budget, Cents, Item } from '../../../core/types';

// The bill check: after a bank sync, what the bank shows about your bills that the plan should know.
// Bills that come out on a different day (Skinny on the 19th, not the 17th) or for a different amount,
// bills paid on another account's card whose money hasn't been moved back yet, and bills not seen at all.

export type CheckKind = 'day' | 'amount' | 'move' | 'late';

export interface BillCheck {
  /** Kept in `budget.billChecks` when you say no (or that it's fine). */
  key: string;
  kind: CheckKind;
  accountId: string;
  itemId: string;
  title: string;
  detail: string;
  /** What the bank showed, most recent last. */
  seen: { date: ISODate; amount: Cents; where: string }[];
  /** The change, made on a copy of the budget inside `update()`, and what its button says. */
  apply?: { label: string; run: (b: Budget) => void };
  /** What "no" says. Answering keeps `key` in `budget.billChecks`. */
  skip: string;
}

/** How far back to look for a bill's usual day and amount. */
const LOOK_BACK = 130;

const paidMatches = (ms: BillMatch[]) => ms.filter((m) => (m.how === 'direct' || m.how === 'card') && m.txn);

/** A bill's usual day, when the bank shows it on another day (at least twice, and all but once). */
export function usualShift(ms: BillMatch[]): { days: number; agree: number } | undefined {
  const done = paidMatches(ms).slice(-4);
  if (done.length < 2) return undefined;
  const agrees = (m: BillMatch, k: number) => {
    const want = addDays(m.outflow.date, k);
    return m.txn!.date === want || m.txn!.date === businessDay(want);
  };
  const count = (k: number) => done.filter((m) => agrees(m, k)).length;
  let best: { days: number; agree: number } | undefined;
  for (const k of new Set(done.map((m) => diffDays(m.outflow.date, m.txn!.date)))) {
    if (k === 0) continue;
    const c = count(k);
    if (!best || c > best.agree || (c === best.agree && Math.abs(k) < Math.abs(best.days))) best = { days: k, agree: c };
  }
  if (!best || best.agree < 2 || best.agree < done.length - 1 || best.agree <= count(0)) return undefined;
  return best;
}

/** A bill's amount now, when its last two payments were the same and not what the plan says. */
export function usualAmount(item: Pick<Item, 'amount'>, ms: BillMatch[]): Cents | undefined {
  const last = paidMatches(ms).filter((m) => !m.shared).slice(-2).map((m) => -m.txn!.amount);
  if (last.length < 2 || !sameAmount(last[0], last[1]) || Math.abs(last[1] - item.amount) < 100) return undefined;
  return Math.min(last[1], item.amount) / Math.max(last[1], item.amount) >= 0.75 ? last[1] : undefined;
}

const dayWord = (item: Item, date: ISODate) => (item.frequency === 'monthly' ? `the ${ordinal(Number(date.slice(8, 10)))}` : `${WEEKDAY_NAMES[weekday(date)]}s`);

/** Everything the bill check would ask about now, across bank-connected accounts. Answered ones are left out. */
export function billChecks(b: Budget, today: ISODate = todayISO()): BillCheck[] {
  const out: BillCheck[] = [];
  const name = (id?: string) => b.accounts.find((a) => a.id === id)?.name ?? 'another account';
  const answered = (key: string) => !!b.billChecks?.[key];
  for (const acc of b.accounts) {
    if (acc.kind !== 'bank' || acc.archived || !bankFed(b, acc.id) || !b.balances?.[acc.id]) continue;
    const items = b.items.filter((i) => i.accountId === acc.id && !i.setAside && !i.envelope && (!i.end || i.end >= today));
    if (!items.length) continue;
    const history = matchBills(b, acc.id, addDays(today, -LOOK_BACK), today, today);
    const where = (m: BillMatch) => (m.how === 'card' ? `${name(m.from)} card` : acc.name);

    for (const item of items) {
      if (!['weekly', 'fortnightly', 'monthly'].includes(item.frequency)) continue;
      const ms = history.filter((m) => m.outflow.itemId === item.id);
      const seen = paidMatches(ms).slice(-4).map((m) => ({ date: m.txn!.date, amount: -m.txn!.amount, where: where(m) }));

      const shift = usualShift(ms);
      if (shift) {
        const last = paidMatches(ms).slice(-1)[0];
        const now = dayWord(item, last.outflow.date), then = dayWord(item, addDays(last.outflow.date, shift.days));
        const key = checkKey('day', item.id, addDays(item.start, shift.days));
        const next = itemDates(item, today, addDays(today, 62), b.settings)[0];
        let detail = `It's set for ${now}, but the bank showed it ${shift.days > 0 ? 'later' : 'earlier'}, on ${then}, ${shift.agree} of the last ${Math.min(4, seen.length)} times.`;
        if (next) {
          const moved = addDays(next, shift.days);
          const p = periodContaining(next, b.settings), q = periodContaining(moved, b.settings);
          if (p.start !== q.start) {
            detail += ` The next one would move from ${fmtShort(next)} to ${fmtShort(moved)}, ${q.start > p.start ? `after payday on ${fmtShort(q.start)}, so the next pay covers it` : `before payday on ${fmtShort(p.start)}, so this pay covers it`}.`;
          }
        }
        if (!answered(key)) out.push({
          key, kind: 'day', accountId: acc.id, itemId: item.id, seen,
          title: `${item.name} comes out on ${then}`, detail,
          apply: { label: `Change to ${then}`, run: (d) => { const it = d.items.find((i) => i.id === item.id); if (it) it.start = addDays(it.start, shift.days); } },
          skip: `Keep ${now}`,
        });
      }

      const amount = usualAmount(item, ms);
      if (amount !== undefined) {
        const key = checkKey('amount', item.id, amount);
        if (!answered(key)) out.push({
          key, kind: 'amount', accountId: acc.id, itemId: item.id, seen,
          title: `${item.name} is now ${cash(amount)}`,
          detail: `It's planned at ${cash(item.amount)}, but the last two payments were ${cash(amount)}.`,
          apply: { label: `Change to ${cash(amount)}`, run: (d) => { const it = d.items.find((i) => i.id === item.id); if (it) it.amount = amount; } },
          skip: `Keep ${cash(item.amount)}`,
        });
      }
    }

    // This pay: bills paid on another card whose money is still here, and bills the bank hasn't shown.
    const t = billTracker(b, acc.id, today);
    for (const m of t.toMove) {
      const id = m.row.match!.outflow.itemId!;
      const txn = m.row.match!.txn!;
      out.push({
        key: checkKey('move', id, m.row.date), kind: 'move', accountId: acc.id, itemId: id,
        seen: [{ date: txn.date, amount: -txn.amount, where: `${name(m.to)} card` }],
        title: `Move ${cash(m.amount)} to ${name(m.to)}`,
        detail: `${m.row.name} came out on the ${name(m.to)} card on ${fmtShort(txn.date)}, so its money is still in ${acc.name}. Once the transfer shows in the bank, this clears itself.`,
        skip: `Keep it in ${acc.name}`,
      });
    }
    for (const r of t.rows) {
      const id = r.itemId;
      if (!r.late || !id || r.days > -3) continue;
      out.push({
        key: checkKey('paid', id, r.date), kind: 'late', accountId: acc.id, itemId: id, seen: [],
        title: `${r.name} hasn't come out`,
        detail: `${cash(r.amount)} was due ${fmtShort(r.date)}, but no account shows it yet, so it's still counted as to come out of ${acc.name}. If it's been paid some other way, say so.`,
        skip: 'It’s been paid',
      });
    }
  }
  return out;
}

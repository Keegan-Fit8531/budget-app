import type { ISODate } from './dates';
import { isKiwiSaver } from './kiwisaver';
import type { Budget, Cents, GoalBankMove, SavingsGoal, Txn } from './types';

// ---------------------------------------------------------------------------------------------
// Money moved to or from a savings goal's fund, seen in your bank accounts. A fund at another provider
// (the wedding fund at Kernel) shows in ANZ as a transfer named after it: "Kernel - Adminis Cus …"
// going out is money paid in, "Kernel Consols Withdrawal" coming in is money taken out. Each one is
// kept on the goal, and one made after the goal's balance was last updated is added to it (or taken
// off it), so the balance is right before the fund's own figure catches up.
// ---------------------------------------------------------------------------------------------

/** The most moves kept on a goal. */
const KEPT = 300;

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);

/**
 * What a goal's transfers say: the words in its account's name that aren't in the goal's (the provider:
 * "Wedding · Kernel" for the goal "Wedding" is "kernel"), at least 4 letters so a short word never
 * matches by chance. None for KiwiSaver (it comes from your salary) or a goal whose account is one of
 * your linked bank accounts (that account's own balance is the goal's).
 */
export function goalWords(b: Budget, goal: SavingsGoal): string[] {
  if (isKiwiSaver(goal)) return [];
  const linked = new Set(b.bankAuto === false ? [] : Object.values(b.bankLinks ?? {}));
  if (linked.has(`account:${goal.accountId}`)) return [];
  const acc = b.accounts.find((a) => a.id === goal.accountId);
  if (!acc || acc.archived) return [];
  const own = new Set(words(goal.name));
  return words(acc.name).filter((w) => w.length >= 4 && !own.has(w));
}

/** The goal a bank account's transaction moves money to or from, if exactly one matches. */
export function goalMoved(b: Budget, t: Txn): SavingsGoal | undefined {
  const text = ` ${words(`${t.description} ${t.merchant ?? ''}`).join(' ')} `;
  const hits = (b.savings ?? []).filter((g) => goalWords(b, g).some((w) => text.includes(` ${w} `)));
  return hits.length === 1 ? hits[0] : undefined;
}

export interface SeenMove { goal: string; amount: Cents; date: ISODate; counted: Cents }

/**
 * Note each move to or from a goal among a bank account's transactions that isn't noted yet. Given
 * every stored transaction, so one already in the account is still found once; never twice.
 */
export function recordGoalMoves(b: Budget, accountId: string, txns: Txn[]): SeenMove[] {
  const have = new Map<string, number>();
  for (const g of b.savings ?? []) for (const m of g.bankMoves ?? []) {
    const k = `${g.id}|${m.date}|${m.amount}|${m.from}`;
    have.set(k, (have.get(k) ?? 0) + 1);
  }
  const out: SeenMove[] = [];
  for (const t of [...txns].sort((x, y) => x.date.localeCompare(y.date))) {
    const goal = goalMoved(b, t);
    if (!goal) continue;
    const amount = -t.amount; // out of the bank account = into the fund
    const kept = goal.bankMoves ?? [];
    if (kept.length >= KEPT && t.date < kept[0].date) continue;
    const k = `${goal.id}|${t.date}|${amount}|${accountId}`;
    const n = have.get(k) ?? 0;
    if (n > 0) { have.set(k, n - 1); continue; }
    goal.bankMoves = [...kept, { date: t.date, amount, from: accountId, counted: 0 }].sort((x, y) => x.date.localeCompare(y.date)).slice(-KEPT);
    out.push({ goal: goal.name, amount, date: t.date, counted: 0 });
  }
  return out;
}

/**
 * Bring a goal's balance up to date with the moves seen. With a balance from the bank connection, it's
 * that balance plus every move after the day the bank had it as at. Otherwise (typed in, or from an
 * upload), each newly seen move after the balance's date is added once and the balance moves on to
 * that day. Returns true if the balance changed.
 */
export function settleGoalMoves(goal: SavingsGoal, fresh: SeenMove[], today: ISODate): boolean {
  const moves = goal.bankMoves ?? [];
  const before = goal.balance;
  if (goal.bankBalance) {
    const base = goal.bankBalance;
    let latest = base.asOf;
    let total = base.amount;
    for (const m of moves) {
      m.counted = m.date > base.asOf ? m.amount : 0;
      if (m.counted) { total += m.counted; if (m.date > latest) latest = m.date; }
    }
    goal.balance = Math.max(0, total);
    goal.asOf = latest < today ? latest : today;
    return goal.balance !== before;
  }
  const since = goal.asOf;
  let latest = since;
  for (const f of fresh) {
    if (f.date <= since) continue;
    const m = [...moves].reverse().find((x) => x.date === f.date && x.amount === f.amount && x.counted === 0);
    if (!m) continue;
    m.counted = m.amount;
    goal.balance = Math.max(0, goal.balance + m.amount);
    if (m.date > latest) latest = m.date;
  }
  goal.asOf = latest < today ? latest : today;
  return goal.balance !== before;
}

/** The bank connection's balance for a goal: kept, so moves after the day the bank had it can go on top. */
export function setGoalBankBalance(goal: SavingsGoal, amount: Cents, asOf: ISODate): void {
  goal.bankBalance = { amount, asOf };
}

export type { GoalBankMove };

import { fmtShort } from '../../core/dates';
import { cash } from '../../core/money';
import type { BillRow, BillTracker } from '../../engine/balances/billTracker';
import type { Account, Budget } from '../../core/types';
import { Disclosure, ShortList } from '../../ui/components';

// What the bank shows for an account's bills this pay (bank-connected accounts): how each bill was paid,
// money to move back for a bill paid on another card, and money you moved in or out yourself.

const accName = (b: Budget, id?: string) => b.accounts.find((a) => a.id === id)?.name ?? 'another account';

/** How a paid bill went out: "Weekly allowance card, 19 Nov · made up 18 Nov". Empty when it simply left on its date. */
export function paidHow(b: Budget, r: BillRow): string {
  const m = r.match;
  if (!m?.how || !m.txn) return '';
  const on = m.txn.date !== r.date ? ` ${fmtShort(m.txn.date)}` : '';
  if (m.how === 'moved') return `moved to ${accName(b, m.from)}${on || ` ${fmtShort(m.txn.date)}`}`;
  if (m.how === 'card') {
    const back = m.cover ? ` · made up ${fmtShort(m.cover.date)}` : m.outflow.itemId ? ' · not made up yet' : '';
    return `${accName(b, m.from)} card${on}${back}`;
  }
  const shared = m.shared && -m.txn.amount !== r.amount ? ` (part of ${cash(-m.txn.amount)})` : '';
  return on || shared ? `out${on}${shared}` : '';
}

/** Bills paid on another account's card whose money is still here: move it across. */
export function ToMoveNotes({ budget, t }: { budget: Budget; t: BillTracker }) {
  if (!t.toMove.length) return null;
  return (
    <>
      {t.toMove.map((m) => (
        <p className="small muted" key={`${m.row.name}-${m.row.date}`}>
          Move <b>{cash(m.amount)}</b> to {accName(budget, m.to)}: {m.row.name} came out on its card on {fmtShort(m.row.match!.txn!.date)}.
        </p>
      ))}
    </>
  );
}

/** Money moved in and out by you this pay, net by account: why there's more (or less) here than the plan says. */
export function movesByAccount(t: BillTracker): { name: string; net: number }[] {
  const by = new Map<string, number>();
  for (const m of t.moves) {
    const name = m.other?.name ?? (m.txn.amount > 0 ? 'other money in' : 'other spending');
    by.set(name, (by.get(name) ?? 0) + m.txn.amount);
  }
  return [...by].map(([name, net]) => ({ name, net })).filter((x) => x.net !== 0).sort((x, y) => Math.abs(y.net) - Math.abs(x.net));
}

/** One line under the figures: "Includes +$130 you moved yourself: +$150 from Allowance storage, …". */
export function MovesSummary({ t }: { t: BillTracker }) {
  const by = movesByAccount(t);
  const net = by.reduce((s, x) => s + x.net, 0);
  if (!by.length || Math.abs(net) < 100) return null;
  const part = (x: { name: string; net: number }) => (x.net > 0 ? `+${cash(x.net)} from ${x.name}` : `−${cash(-x.net)} to ${x.name}`);
  return (
    <p className="small muted">
      {net > 0 ? 'Includes' : 'Down'} {net > 0 ? '+' : '−'}{cash(Math.abs(net))} you moved yourself this pay ({by.slice(0, 3).map(part).join(', ')}{by.length > 3 ? ', …' : ''}), not from payday.
    </p>
  );
}

/** Every transaction behind `MovesSummary`, in date order. */
export function OtherMoves({ t, account }: { t: BillTracker; account: Account }) {
  if (!t.moves.length) return null;
  const net = t.moves.reduce((s, m) => s + m.txn.amount, 0);
  return (
    <Disclosure title="Other money in and out" meta={`${net >= 0 ? '+' : '−'}${cash(Math.abs(net))}`}>
      <ShortList>
        {t.moves.map(({ txn, other }, i) => (
          <div className="list-row small" key={`${txn.date}-${txn.amount}-${i}`}>
            <span style={{ flex: '0 0 72px' }} className="muted">{fmtShort(txn.date)}</span>
            <span className="grow clip">{other ? `${txn.amount > 0 ? 'From' : 'To'} ${other.name}` : txn.merchant || txn.description}</span>
            <span className="num">{txn.amount > 0 ? '+' : '−'}{cash(Math.abs(txn.amount))}</span>
          </div>
        ))}
      </ShortList>
      <p className="xs muted">Not payday’s deposit and not a bill: money moved in or out of {account.name} by you.</p>
    </Disclosure>
  );
}

import { useState } from 'react';
import { addDays, fmtShort } from '../../core/dates';
import { cash } from '../../core/money';
import type { Account, Budget, Item } from '../../core/types';
import type { BillTracker } from '../../engine/balances/billTracker';
import { asideLabel, asideSplit, isSetAside, setAsidePerPay } from '../../engine/setAside';
import { useBudget } from '../../state/store';
import { Disclosure, ShortList } from '../../ui/components';
import { PartsBar } from '../../ui/PartsBar';
import { asideSpends, asideSpentSince, unsortedAsideSpends, type AsideSpend } from './logic/asideSpends';

// An account that only holds money put aside (Car maintenance: WOF / rego, maintenance): what's built up
// for each cost, and what the money has been spent on (asked about as it leaves).

/** A colour per put-aside cost on the bar (Haircut, WOF, maintenance), so neighbours differ. */
const ASIDE_COLORS = ['var(--pal-orchid)', 'var(--pal-plum)', 'var(--pal-indigo)', 'var(--pal-rose)'];
export const asideColor = (i: number) => ASIDE_COLORS[i % ASIDE_COLORS.length];

/**
 * On the card: money out this pay to say about, what's put aside for each cost (a tile each; a bar and a
 * total when there are more than three), and one line on what's been spent. The name line above already
 * says what next payday adds, so it isn't repeated.
 */
export function AsideSummary({ budget, account, t, maxAside, today }: {
  budget: Budget; account: Account; t: BillTracker; maxAside?: number; today: string;
}) {
  const unsorted = unsortedAsideSpends(budget, account.id, today);
  const known = t.balanceKnown && t.balanceSource === 'entered';
  const costs = budget.items.filter((i) => i.accountId === account.id && isSetAside(i));
  const split = new Map(asideSplit(budget, account.id, known ? t.balance : 0).map((x) => [x.item.id, x.amount]));
  const sub = (i: Item, have: number) => (i.maxSaved ? (have >= i.maxSaved ? 'full' : `of ${cash(i.maxSaved)}`) : `${cash(setAsidePerPay(i))} a month`);
  const spent = asideSpends(budget, account.id).filter((s) => s.txn.date >= addDays(today, -365));
  const spentTotal = spent.reduce((a, s) => a - s.txn.amount, 0);
  return (
    <div className="stack gap-8">
      {unsorted.map((s) => <SpendQuestion key={s.key} s={s} />)}
      {t.balanceKnown && costs.length > 3 && known && t.balance > 0 && (
        <PartsBar label={`${account.name}: tap a part to see it`} parts={costs.map((i, n) => ({
          label: asideLabel(i.name), value: split.get(i.id) ?? 0, color: asideColor(n), note: sub(i, split.get(i.id) ?? 0),
        }))} />
      )}
      {t.balanceKnown && (
        <div className="trio">
          {(costs.length > 3 ? [] : costs).map((i) => (
            <div className="stat" key={i.id}>
              <span className="small muted clip">{asideLabel(i.name)}</span>
              <b>{known ? cash(split.get(i.id) ?? 0) : '—'}</b>
              <span className="xs muted">{sub(i, split.get(i.id) ?? 0)}</span>
            </div>
          ))}
          {costs.length > 3 && (
            <div className="stat">
              <span className="small muted">Put aside</span>
              <b>{known ? cash(maxAside !== undefined ? Math.min(Math.max(0, t.balance), maxAside) : Math.max(0, t.balance)) : '—'}</b>
              <span className="xs muted">for {costs.length} costs</span>
            </div>
          )}
        </div>
      )}
      {known && maxAside !== undefined && t.balance > maxAside && (
        <p className="small muted">{cash(t.balance - maxAside)} spare above the {cash(maxAside)} max.</p>
      )}
      {spent.length > 0 && (
        <p className="small muted clip">Spent {cash(spentTotal)} in the past year, last on {fmtShort(spent[0].txn.date)}</p>
      )}
    </div>
  );
}

/** The shop a spend paid, else where the money went. */
const shopOf = (s: AsideSpend) => (s.paidFor ? s.paidFor.txn.merchant || s.paidFor.txn.description : `to ${s.to?.name ?? 'another account'}`);

/** Which put-aside cost did this money out pay for? Your answer is kept (`budget.asideSpends`). */
function SpendQuestion({ s, onDone }: { s: AsideSpend; onDone?: () => void }) {
  const { update } = useBudget();
  const p = s.to && s.paidFor;
  const pick = (id: string) => {
    update((b) => { b.asideSpends = { ...(b.asideSpends ?? {}), [s.key]: id }; return b; });
    onDone?.();
  };
  return (
    <div className="stack gap-6">
      <p className="small">
        <b>{cash(-s.txn.amount)} {s.to ? `moved to ${s.to.name}` : `paid to ${shopOf(s)}`} on {fmtShort(s.txn.date)}.</b> What was it for?
        {p ? <span className="muted"> Probably {shopOf(s)} ({cash(-p.txn.amount)}).</span> : null}
      </p>
      <div className="row wrap gap-6">
        {s.likely.map((i) => <button key={i.id} className="btn small" onClick={() => pick(i.id)}>{asideLabel(i.name)}</button>)}
        <button className="btn small ghost" onClick={() => pick('')}>Something else</button>
        {onDone && <button className="btn small ghost" onClick={onDone}>Cancel</button>}
      </div>
    </div>
  );
}

/** Behind Details: everything the put-aside money paid for, with each cost's total over the last year. */
export function AsideSpendsDetail({ budget, account, today }: { budget: Budget; account: Account; today: string }) {
  const spends = asideSpends(budget, account.id);
  const year = asideSpentSince(spends, addDays(today, -365));
  const total = [...year.values()].reduce((a, x) => a + x, 0);
  const name = (id?: string) => asideLabel(budget.items.find((i) => i.id === id)?.name ?? 'A removed cost');
  return (
    <Disclosure title="What it was spent on" meta={total ? `${cash(total)} in the past year` : undefined}>
      {spends.length === 0 && (
        <p className="small muted">Nothing yet. When money leaves {account.name}, the card asks what it was for and keeps it here.</p>
      )}
      {spends.length > 1 && [...year].map(([id, amount]) => (
        <div className="list-row small" key={id}>
          <span className="grow">{name(id)}</span>
          <b className="num">{cash(amount)}</b>
        </div>
      ))}
      {spends.length > 0 && <ShortList>{spends.map((s) => <SpentRow key={s.key} s={s} name={name(s.itemId)} />)}</ShortList>}
    </Disclosure>
  );
}

/** "23 Nov  NZ Transport · WOF / rego  $200", with Change. */
function SpentRow({ s, name }: { s: AsideSpend; name: string }) {
  const [changing, setChanging] = useState(false);
  if (changing) return <SpendQuestion s={s} onDone={() => setChanging(false)} />;
  return (
    <div className="list-row small">
      <span style={{ flex: '0 0 72px' }} className="muted">{fmtShort(s.txn.date)}</span>
      <span className="grow min0">
        <span className="block clip">{shopOf(s)}</span>
        <span className="xs muted block">{name}</span>
      </span>
      <span className="num">{cash(-s.txn.amount)}</span>
      <button className="btn small ghost" onClick={() => setChanging(true)}>Change</button>
    </div>
  );
}

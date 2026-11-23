import { useState } from 'react';
import { addDays, fmtShort } from '../../core/dates';
import { cash } from '../../core/money';
import type { Account, Budget } from '../../core/types';
import type { BillTracker } from '../../engine/balances/billTracker';
import { asideSplit, setAsidePerPay } from '../../engine/setAside';
import { useBudget } from '../../state/store';
import { Disclosure, ShortList } from '../../ui/components';
import { PartsBar } from '../../ui/PartsBar';
import { asideSpends, asideSpentSince, unsortedAsideSpends, type AsideSpend } from './logic/asideSpends';

// An account that only holds money put aside (Car maintenance: WOF / rego, maintenance): what's built up,
// what next payday adds, and what the money has been spent on (asked about as it leaves).

/** A colour per put-aside cost on the bar (Haircut, WOF, maintenance), so neighbours differ. */
const ASIDE_COLORS = ['var(--pal-orchid)', 'var(--pal-plum)', 'var(--pal-indigo)', 'var(--pal-rose)'];
export const asideColor = (i: number) => ASIDE_COLORS[i % ASIDE_COLORS.length];

/** On the card: what was spent this pay that needs an answer, the bar of what it's for, and Put aside / Next pay adds. */
export function AsideSummary({ budget, account, t, names, namesShort, maxAside, today }: {
  budget: Budget; account: Account; t: BillTracker; names: string; namesShort: string; maxAside?: number; today: string;
}) {
  const unsorted = unsortedAsideSpends(budget, account.id, today);
  return (
    <div className="stack gap-8">
      {unsorted.map((s) => <SpendQuestion key={s.key} budget={budget} s={s} />)}
      {t.balanceKnown && t.balanceSource === 'entered' && t.balance > 0 && (
        <PartsBar label={`${account.name}: tap a part to see it`} parts={[
          ...asideSplit(budget, account.id, t.balance).map((x, i) => ({
            label: x.item.name, value: x.amount, color: asideColor(i),
            note: x.item.maxSaved ? (x.amount >= x.item.maxSaved ? 'full' : `max ${cash(x.item.maxSaved)}`) : `${cash(setAsidePerPay(x.item))} a month`,
          })),
          { label: 'Spare above the max', value: maxAside !== undefined ? Math.max(0, t.balance - maxAside) : 0, color: 'var(--good)' },
        ]} />
      )}
      {t.balanceKnown && (
        <div className="trio">
          <div className="stat">
            <span className="small muted">Put aside</span>
            <b>{t.balanceSource === 'entered'
              ? cash(maxAside !== undefined ? Math.min(Math.max(0, t.balance), maxAside) : Math.max(0, t.balance))
              : '—'}</b>
            <span className="xs muted">{namesShort !== names && maxAside !== undefined ? `max ${cash(maxAside)}` : `for ${namesShort}`}</span>
          </div>
          <div className="stat">
            <span className="small muted">Next pay adds</span>
            <b>+{cash(t.next.deposit)}</b>
            <span className="xs muted">on {fmtShort(t.next.period.start)}</span>
          </div>
        </div>
      )}
      {t.balanceKnown && maxAside !== undefined && t.balanceSource === 'entered' && t.balance > maxAside && (
        <p className="small muted">{cash(t.balance - maxAside)} spare above the {cash(maxAside)} max.</p>
      )}
    </div>
  );
}

/** "$200 to Weekly allowance on 23 Nov", or the shop for a purchase straight from the account. */
const what = (s: AsideSpend) => (s.to ? `${cash(-s.txn.amount)} to ${s.to.name} on ${fmtShort(s.txn.date)}`
  : `${s.txn.merchant || s.txn.description} ${cash(-s.txn.amount)} on ${fmtShort(s.txn.date)}`);

/** Was this money out spent from the put-aside money, and on which? Your answer is kept (`budget.asideSpends`). */
function SpendQuestion({ budget, s, onDone }: { budget: Budget; s: AsideSpend; onDone?: () => void }) {
  const { update } = useBudget();
  const p = s.to && s.paidFor;
  const where = p && p.accountId !== s.to?.id ? ` in ${budget.accounts.find((a) => a.id === p.accountId)?.name}` : '';
  const pick = (id: string) => {
    update((b) => { b.asideSpends = { ...(b.asideSpends ?? {}), [s.key]: id }; return b; });
    onDone?.();
  };
  return (
    <div className="stack gap-6">
      <p className="small">
        <b>{what(s)}.</b> Was it spent from the money put aside?
        {p ? <span className="muted"> {p.txn.merchant || p.txn.description} {cash(-p.txn.amount)} on {fmtShort(p.txn.date)}{where} looks like it.</span> : null}
      </p>
      <div className="row wrap gap-6">
        {s.likely.map((i) => <button key={i.id} className="btn small" onClick={() => pick(i.id)}>{i.name}</button>)}
        <button className="btn small ghost" onClick={() => pick('')}>No, something else</button>
        {onDone && <button className="btn small ghost" onClick={onDone}>Cancel</button>}
      </div>
    </div>
  );
}

/** Behind Details: everything you said the put-aside money paid for, with the last 12 months' total per cost. */
export function AsideSpendsDetail({ budget, account, today }: { budget: Budget; account: Account; today: string }) {
  const spends = asideSpends(budget, account.id);
  const year = asideSpentSince(spends, addDays(today, -365));
  const total = [...year.values()].reduce((a, x) => a + x, 0);
  const name = (id?: string) => budget.items.find((i) => i.id === id)?.name ?? 'A removed cost';
  return (
    <Disclosure title="Spent from put aside" meta={`${cash(total)} in 12 months`}>
      {spends.length === 0 && (
        <p className="small muted">Nothing yet. When money leaves {account.name}, the card asks what it paid for, and it’s kept here.</p>
      )}
      {spends.length > 1 && [...year].map(([id, amount]) => (
        <div className="list-row small" key={id}>
          <span className="grow">{name(id)}</span>
          <b className="num">{cash(amount)}</b>
        </div>
      ))}
      {spends.length > 0 && <ShortList>{spends.map((s) => <SpentRow key={s.key} budget={budget} s={s} name={name(s.itemId)} />)}</ShortList>}
    </Disclosure>
  );
}

/** "23 Nov  NZ Transport · WOF / rego set-aside  $200", with Change. */
function SpentRow({ budget, s, name }: { budget: Budget; s: AsideSpend; name: string }) {
  const [changing, setChanging] = useState(false);
  if (changing) return <SpendQuestion budget={budget} s={s} onDone={() => setChanging(false)} />;
  const shop = s.paidFor ? s.paidFor.txn.merchant || s.paidFor.txn.description : `To ${s.to?.name ?? 'another account'}`;
  return (
    <div className="list-row small">
      <span style={{ flex: '0 0 72px' }} className="muted">{fmtShort(s.txn.date)}</span>
      <span className="grow min0">
        <span className="block clip">{shop}</span>
        <span className="xs muted block">{name}</span>
      </span>
      <span className="num">{cash(-s.txn.amount)}</span>
      <button className="btn small ghost" onClick={() => setChanging(true)}>Change</button>
    </div>
  );
}

import { useState } from 'react';
import { fmtShort } from '../lib/dates';
import { cash } from '../lib/money';
import { CATEGORY_LABEL, categorizeTxn, cleanDescription, type ShopCategories } from '../lib/spending';
import { useBudget } from '../lib/store';
import type { Txn } from '../lib/types';
import { Disclosure } from './ui';

/** Transactions from bank or card exports, latest first, each with the category it's counted in. */
export function TransactionList({ items, card }: { items: Txn[]; card?: boolean }) {
  const mine = useBudget().budget.shopCategories as ShopCategories | undefined;
  const [shown, setShown] = useState(8);
  if (!items.length) return null;
  const latest = items.slice().reverse();
  return (
    <Disclosure title="Transactions" meta={`${items.length} since ${fmtShort(items[0].date)}${items[0].date.slice(0, 4) !== items[items.length - 1].date.slice(0, 4) ? ` ${items[0].date.slice(0, 4)}` : ''}`}>
      <div>
      {latest.slice(0, shown).map((t, i) => (
        <div key={`${t.date}-${i}`} className="list-row small">
          <span style={{ flex: '0 0 56px' }} className="muted">{fmtShort(t.date)}</span>
          <span className="grow min0">
            {cleanDescription(t.description)}
            <span className="xs muted block">{t.amount > 0 ? (card ? 'Payment' : 'Money in') : CATEGORY_LABEL[categorizeTxn(t, mine).category]}</span>
          </span>
          <b className="num">{t.amount > 0 ? `+${cash(t.amount)}` : `−${cash(-t.amount)}`}</b>
        </div>
      ))}
      </div>
      {latest.length > shown && <button className="btn small ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setShown(shown + 50)}>Show {Math.min(50, latest.length - shown)} more</button>}
    </Disclosure>
  );
}

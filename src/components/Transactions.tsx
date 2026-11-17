import { useState } from 'react';
import { fmtShort } from '../lib/dates';
import { cash } from '../lib/money';
import { CATEGORY_LABEL, categorizeTxn, cleanDescription, type ShopCategories } from '../lib/spending';
import { useBudget } from '../lib/store';
import type { Txn } from '../lib/types';
import { Disclosure } from './ui';
import { transferTo } from '../lib/bank';

/** Transactions from bank or card exports, latest first, each with the category it's counted in. */
export function TransactionList({ items, card, pending = [], first = 8 }: {
  items: Txn[]; card?: boolean;
  /** Not settled yet (today's card purchases): shown first, marked as pending. */
  pending?: Txn[];
  /** How many show before "Show more". */
  first?: number;
}) {
  const { budget } = useBudget();
  const mine = budget.shopCategories as ShopCategories | undefined;
  const [shown, setShown] = useState(first);
  if (!items.length && !pending.length) return null;
  const latest = [...pending.slice().reverse().map((t) => ({ ...t, pending: true })), ...items.slice().reverse().map((t) => ({ ...t, pending: false }))];
  return (
    <Disclosure title="Transactions" meta={items.length + pending.length}>
      <div>
      {latest.slice(0, shown).map((t, i) => { const own = transferTo(budget, t.description); return (
        <div key={`${t.date}-${i}`} className={`list-row small${t.pending ? ' pending' : ''}`}>
          <span style={{ flex: '0 0 56px' }} className="muted">{fmtShort(t.date)}</span>
          <span className="grow min0">
            {own ? `${own.dir === 'to' ? 'To' : 'From'} ${own.name}` : cleanDescription(t.description)}
            <span className="xs muted block">{t.pending ? 'Pending' : own ? 'Between your accounts' : t.amount > 0 ? (card ? 'Payment' : 'Money in') : CATEGORY_LABEL[categorizeTxn(t, mine).category]}</span>
          </span>
          <b className="num">{t.amount > 0 ? `+${cash(t.amount)}` : `−${cash(-t.amount)}`}</b>
        </div>
      ); })}
      </div>
      {latest.length > shown && <button className="btn small ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setShown(shown + 10)}>Show {Math.min(10, latest.length - shown)} more</button>}
    </Disclosure>
  );
}

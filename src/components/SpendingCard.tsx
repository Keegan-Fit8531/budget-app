import { useState } from 'react';
import { colorAt, tone } from '../lib/colors';
import { addDays, todayISO } from '../lib/dates';
import { cash } from '../lib/money';
import { CATEGORY_LABEL, summarize, type ShopCategories, type SpendCategory } from '../lib/spending';
import { useBudget } from '../lib/store';
import type { Txn } from '../lib/types';
import { Icon } from './Icon';
import { Dot } from './ui';

const RANGES = [{ days: 30, label: '30 days' }, { days: 91, label: '3 months' }, { days: 365, label: '12 months' }] as const;

/** Insights → where your money went: spending from the bank and card exports you've uploaded, by category. */
export function SpendingCard() {
  const { budget, update } = useBudget();
  const mine = budget.shopCategories as ShopCategories | undefined;
  /** Put a shop in another category from now on (kept in your budget, so it syncs). */
  const recategorize = (shop: string, category: SpendCategory) => update((b) => { b.shopCategories = { ...(b.shopCategories ?? {}), [shop.toLowerCase()]: category }; return b; });
  const sources = [
    ...(budget.debts ?? []).filter((d) => d.transactions?.length).map((d) => ({ id: `debt:${d.id}`, name: d.name, txns: d.transactions! })),
    ...budget.accounts.filter((a) => budget.accountTransactions?.[a.id]?.length).map((a) => ({ id: `account:${a.id}`, name: a.name, txns: budget.accountTransactions![a.id] })),
  ];
  const [source, setSource] = useState('all');
  const [days, setDays] = useState<number>(91);
  const [open, setOpen] = useState<string | null>(null);

  if (!sources.length) {
    return (
      <section className="card stack gap-8">
        <h2 className="h2">Where your money went</h2>
        <p className="note">Upload a CSV export of your card or everyday account (Add → Upload a payslip or statement) to see what your spending goes on.</p>
      </section>
    );
  }
  const today = todayISO();
  const from = addDays(today, -days + 1);
  const txns: Txn[] = (source === 'all' ? sources : sources.filter((x) => x.id === source)).flatMap((x) => x.txns);
  const s = summarize(txns, from, today, mine);
  const weeks = days / 7;
  const fun = s.categories.filter((c) => ['takeaways', 'eating-out', 'gambling', 'games', 'shopping', 'bnpl'].includes(c.category));
  const topShop = s.categories.flatMap((c) => c.shops).sort((a, b) => b.count - a.count)[0];
  const tips = [
    fun[0] && `${CATEGORY_LABEL[fun[0].category]}: ${cash(fun[0].total, { whole: true })} across ${fun[0].count} purchase${fun[0].count === 1 ? '' : 's'}, about ${cash(fun[0].total / weeks, { whole: true })} a week.`,
    s.small.count >= 5 && `${s.small.count} purchases under $20 added up to ${cash(s.small.total, { whole: true })} (${Math.round((s.small.total / (s.total || 1)) * 100)}% of spending).`,
    topShop && topShop.count >= 3 && `Most often: ${topShop.shop}, ${topShop.count} times (${cash(topShop.total, { whole: true })}).`,
  ].filter((t): t is string => !!t);

  return (
    <section className="card stack gap-16">
      <h2 className="h2">Where your money went</h2>
      <div className="row wrap gap-8">
        {sources.length > 1 && (
          <select aria-label="Which card or account" value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="all">All uploaded</option>
            {sources.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        )}
        <div className="seg" role="group" aria-label="How far back">
          {RANGES.map((r) => <button key={r.days} aria-pressed={days === r.days} onClick={() => setDays(r.days)}>{r.label}</button>)}
        </div>
      </div>
      {s.count === 0 ? <p className="note">No purchases in the last {RANGES.find((r) => r.days === days)!.label} in what you’ve uploaded.</p> : (
        <>
          <p className="small">{cash(s.total, { whole: true })} spent on {s.count} purchase{s.count === 1 ? '' : 's'}{sources.length > 1 && source === 'all' ? ' across your uploads' : ''}, about {cash(s.total / weeks, { whole: true })} a week. Payments, refunds and transfers aren’t counted.</p>
          {/* Each category as a bar; tap one to see the places it went. */}
          <div className="bar-list" role="list">
            {s.categories.map((c, i) => (
              <div key={c.category} role="listitem" className="stack gap-6">
                <button className="bar-list-row plain" style={{ width: '100%', textAlign: 'left', cursor: 'pointer', background: 'none', border: 0, padding: 0, color: 'inherit', font: 'inherit' }}
                  aria-expanded={open === c.category} onClick={() => setOpen(open === c.category ? null : c.category)}>
                  <span className="row gap-8 min0"><Dot color={colorAt(i)} /><span className="clip">{CATEGORY_LABEL[c.category]}</span></span>
                  <span className="num muted">{cash(c.total, { whole: true })}</span>
                  <b className="num right">{Math.round((c.total / (s.total || 1)) * 100)}%</b>
                  <div className="track" aria-hidden="true"><div style={{ width: `${(c.total / (s.categories[0]?.total || 1)) * 100}%`, background: tone(colorAt(i)) }} /></div>
                </button>
                {open === c.category && (
                  <div className="inset stack gap-2" style={{ padding: 'var(--s-3)' }}>
                    <span className="xs muted">{c.count} purchase{c.count === 1 ? '' : 's'}, about {cash(c.total / weeks, { whole: true })} a week</span>
                    {c.shops.slice(0, 10).map((x) => (
                      <div key={x.shop} className="row nowrap gap-8 small">
                        <span className="grow min0 clip">{x.shop}{x.count > 1 ? ` (${x.count})` : ''}</span>
                        <span className="num">{cash(x.total)}</span>
                        <select aria-label={`Category for ${x.shop}`} value={c.category} style={{ maxWidth: 110, fontSize: 12, minHeight: 28, padding: '0 4px' }}
                          onChange={(e) => recategorize(x.shop, e.target.value as SpendCategory)}>
                          {(Object.keys(CATEGORY_LABEL) as SpendCategory[]).map((k) => <option key={k} value={k}>{CATEGORY_LABEL[k]}</option>)}
                        </select>
                      </div>
                    ))}
                    <span className="xs muted">Change a shop’s category and it stays that way for its purchases.</span>
                  </div>
                )}
              </div>
            ))}
          </div>
          <span className="xs muted">Tap a category to see where it went.</span>
          {tips.length > 0 && (
            <div>
              {tips.map((t) => <div className="list-row top small" key={t}><span className="muted" style={{ display: 'grid', marginTop: 2 }}><Icon name="bulb" size={16} /></span><span>{t}</span></div>)}
            </div>
          )}
        </>
      )}
    </section>
  );
}

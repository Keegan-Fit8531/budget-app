import { useState } from 'react';
import { allTxns, sortShops } from '../lib/reader/sortShops';
import { readReaderConfig } from '../lib/reader/config';
import { errorMessage, ReaderError } from '../lib/reader/errors';
import { showToast } from './toast';
import { colorAt, tone } from '../lib/colors';
import { addDays, todayISO } from '../lib/dates';
import { cash } from '../lib/money';
import { CATEGORY_LABEL, otherShops, shopMap, summarize, type SpendCategory } from '../lib/spending';
import { useBudget } from '../lib/store';
import type { Txn } from '../lib/types';
import { Icon } from './Icon';
import { Dot } from './ui';

const RANGES = [{ days: 30, label: '30 days' }, { days: 91, label: '3 months' }, { days: 365, label: '12 months' }] as const;

/** Insights → where your money went: spending from the bank and card exports you've uploaded, by category. */
export function SpendingCard() {
  const { budget, update } = useBudget();
  const mine = shopMap(budget);
  /** Whether a shop's category is Gemini's guess, not your own choice. */
  const isGuess = (shop: string) => { const k = shop.toLowerCase(); return !budget.shopCategories?.[k] && !!budget.shopGuesses?.[k] && budget.shopGuesses[k] !== 'other'; };
  /** Put a shop in another category from now on (kept in your budget, so it syncs). */
  const recategorize = (shop: string, category: SpendCategory) => update((b) => { b.shopCategories = { ...(b.shopCategories ?? {}), [shop.toLowerCase()]: category }; return b; });
  const sources = [
    ...(budget.debts ?? []).filter((d) => d.transactions?.length).map((d) => ({ id: `debt:${d.id}`, name: d.name, txns: d.transactions! })),
    ...budget.accounts.filter((a) => budget.accountTransactions?.[a.id]?.length).map((a) => ({ id: `account:${a.id}`, name: a.name, txns: budget.accountTransactions![a.id] })),
  ];
  const [source, setSource] = useState('all');
  const [days, setDays] = useState<number>(91);
  const [open, setOpen] = useState<string | null>(null);
  const [sorting, setSorting] = useState(false);
  const unsorted = otherShops(allTxns(budget), budget);
  const guessed = Object.keys(budget.shopGuesses ?? {}).filter((k) => !budget.shopCategories?.[k]).length;
  /** Ask Gemini about the shops in Other; with `again`, also check every guess it made before (your own choices stay). */
  async function sortNow(again = false) {
    setSorting(true);
    try {
      const got = await sortShops(budget, undefined, again);
      const before = budget.shopGuesses ?? {};
      const changed = Object.entries(got).filter(([k, c]) => before[k] !== c).length;
      const placed = Object.values(got).filter((c) => c !== 'other').length;
      update((b) => { b.shopGuesses = { ...(b.shopGuesses ?? {}), ...got }; return b; });
      showToast(again
        ? (changed ? `Gemini looked them up again and moved ${changed} shop${changed === 1 ? '' : 's'}. Tap a category to change any.` : 'Gemini looked them up again: no changes.')
        : placed ? `Sorted ${placed} shop${placed === 1 ? '' : 's'} out of Other. Tap a category to change any.` : 'Gemini couldn’t place any more of them.');
    } catch (e) {
      const m = e instanceof ReaderError ? errorMessage(e) : { title: 'Something went wrong.', body: 'Try again.' };
      showToast(`${m.title} ${m.body}`);
    } finally { setSorting(false); }
  }

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
                        <span className="grow min0 clip">{x.shop}{x.count > 1 ? ` (${x.count})` : ''}{isGuess(x.shop) && <span className="xs muted"> · Gemini’s guess</span>}</span>
                        <span className="num">{cash(x.total)}</span>
                        <select aria-label={`Category for ${x.shop}`} value={c.category} style={{ maxWidth: 110, fontSize: 12, minHeight: 28, padding: '0 4px' }}
                          onChange={(e) => recategorize(x.shop, e.target.value as SpendCategory)}>
                          {(Object.keys(CATEGORY_LABEL) as SpendCategory[]).map((k) => <option key={k} value={k}>{CATEGORY_LABEL[k]}</option>)}
                        </select>
                      </div>
                    ))}
                    <span className="xs muted">Change a shop’s category and it stays that way for its purchases. Gemini also follows your choices when it sorts.</span>
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="row between wrap gap-8">
            <span className="xs muted">Tap a category to see where it went.</span>
            {guessed > 0 && readReaderConfig() && (
              <button className="btn small" disabled={sorting} onClick={() => void sortNow(true)} title="Gemini looks up every shop it sorted again. Shops you chose yourself stay as they are.">
                <Icon name="wand" size={16} /> {sorting ? 'Checking…' : 'Check Gemini’s guesses again'}
              </button>
            )}
          </div>
          {unsorted.length > 0 && (
            <div className="tip small between">
              <span><b>{unsorted.length} shop{unsorted.length === 1 ? '' : 's'}</b> are in Other because the app doesn’t know them. Gemini can look them up and sort them (it sees the shop names and purchase amounts, not dates or accounts).</span>
              <button className="btn small" disabled={sorting || !readReaderConfig()} onClick={() => void sortNow()}><Icon name="wand" size={16} /> {sorting ? 'Sorting…' : 'Sort them'}</button>
            </div>
          )}
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

import { useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { AccIcon, Chevron, ColorPicker, PageHead } from '../components/ui';
import { ItemModal } from '../components/ItemModal';
import { fmtShort, todayISO } from '../lib/dates';
import { depositFor, exactNeed, modeOf, smoothAmount, topsUp } from '../lib/balances';
import { averageNeed, convert, isSetAside, itemDates, periodContaining, planFor, setAsidePerPay, shiftPeriod } from '../lib/engine';
import { PayNav, useViewPeriod } from '../lib/period';
import { cash, centsToInput, parseMoney } from '../lib/money';
import { nextColor } from '../lib/colors';
import { newId, useBudget } from '../lib/store';
import { asideNames, balancedMode } from '../lib/rebalance';
import type { Account, Budget, Item, PaydayMode } from '../lib/types';

const items0 = (b: Budget, id: string) => b.items.some((i) => i.accountId === id);

const FREQ_LABEL = { once: 'one-off', weekly: 'weekly', fortnightly: 'fortnightly', monthly: 'monthly', yearly: 'yearly' };

export function Deposits({ openId }: { openId?: string }) {
  const { budget, update } = useBudget();
  const [open, setOpen] = useState<string | null>(openId ?? null);
  const [modal, setModal] = useState<{ item?: Item; accountId?: string } | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  useEffect(() => { if (openId) setOpen(openId); }, [openId]);

  const { period } = useViewPeriod();
  const plan = planFor(budget, period);

  function addAccount() {
    const id = newId();
    update((b) => {
      b.accounts.push({ id, name: 'New account', kind: 'bank', color: nextColor(b.accounts.map((x) => x.color)), groupId: b.groups[0]?.id ?? '' });
      b.split.push({ accountId: id, amount: 0 });
      return b;
    });
    setOpen(id);
  }

  // Debts and savings goals are managed in their own tabs.
  const managed = new Set([...(budget.debts ?? []).map((d) => d.accountId), ...(budget.savings ?? []).map((g) => g.accountId)]);
  const shown = budget.accounts.filter((a) => !managed.has(a.id) && (showArchived || !a.archived));

  return (
    <>
      <PageHead title="Deposits and transfers" sub="What each payday sends to your accounts, and the costs paid from each.">
        <PayNav compact />
        <button className="btn primary" onClick={addAccount}><Icon name="plus" /> Add account</button>
      </PageHead>

      <div className="stack gap-12">
        {shown.map((a) => (
          <AccountSection key={a.id} account={a} open={open === a.id}
            onToggle={() => setOpen(open === a.id ? null : a.id)}
            periodNeed={plan.accounts.find((p) => p.account.id === a.id)?.need ?? 0}
            periodSends={plan.accounts.find((p) => p.account.id === a.id)?.funded ?? 0}
            periodDays={period.days}
            onEditItem={(item) => setModal({ item })}
            onAddItem={() => setModal({ accountId: a.id })} />
        ))}
      </div>
      <p className="note">Balances are in <a href="#/accounts">Accounts</a>. Cards, Afterpay and people you owe are in <a href="#/debts">Debts</a>. Wedding and other goals are in <a href="#/savings">Savings</a>.</p>
      {budget.accounts.some((a) => a.archived && !managed.has(a.id)) && (
        <button className="btn ghost small" onClick={() => setShowArchived(!showArchived)}>
          {showArchived ? 'Hide archived' : 'Show archived accounts'}
        </button>
      )}
      {modal && <ItemModal item={modal.item} accountId={modal.accountId} onClose={() => setModal(null)} />}
    </>
  );
}

function AccountSection({ account: a, open, onToggle, periodNeed, periodSends, periodDays, onEditItem, onAddItem }: {
  account: Account; open: boolean; onToggle: () => void; periodNeed: number;
  /** What the pay being viewed sends here: the same figure the Planner shows. */
  periodSends: number; periodDays: number;
  onEditItem: (i: Item) => void; onAddItem: () => void;
}) {
  const { budget, update } = useBudget();
  const isPay = a.id === budget.settings.payAccountId;
  const line = budget.split.find((l) => l.accountId === a.id);
  const split = line?.amount ?? 0;
  const mode = modeOf(line);
  // Balancing picks the payday amount for accounts with costs, so only the choices that stick are offered.
  const balanced = balancedMode(budget, a.id);
  const steady = mode === 'smooth' || items0(budget, a.id) ? smoothAmount(budget, a.id) : 0;
  const hasBalance = !!budget.balances?.[a.id];
  const [splitText, setSplitText] = useState(centsToInput(split));
  useEffect(() => setSplitText(centsToInput(split)), [split]);
  const items = budget.items.filter((i) => i.accountId === a.id).sort((x, y) => x.name.localeCompare(y.name));
  const avgNeed = averageNeed(budget, a.id);
  const today = todayISO();
  // Money put aside here (a WOF, tyres) stays in the account; the bills are what really comes out.
  const bills = items.filter((i) => !isSetAside(i));
  const asides = items.filter(isSetAside);
  const asidePerPay = asides.filter((i) => !i.end || i.end >= today).reduce((t, i) => t + setAsidePerPay(i), 0);

  function set<K extends keyof Account>(k: K, val: Account[K]) {
    update((b) => { const acc = b.accounts.find((x) => x.id === a.id); if (acc) acc[k] = val; return b; });
  }
  function setSplit(c: number) {
    update((b) => {
      const l = b.split.find((x) => x.accountId === a.id);
      if (l) l.amount = c; else b.split.push({ accountId: a.id, amount: c });
      return b;
    });
  }
  function setMode(m: PaydayMode) {
    update((b) => {
      const l = b.split.find((x) => x.accountId === a.id);
      if (l) { l.mode = m; delete l.auto; } else b.split.push({ accountId: a.id, amount: 0, mode: m });
      // One-pay adjustments were worked out for the old mode, so drop them for this pay on.
      const from = periodContaining(todayISO(), b.settings).start;
      for (const [start, o] of Object.entries(b.overrides ?? {})) if (start >= from && o && a.id in o) delete o[a.id];
      return b;
    });
  }
  function commitSplit() {
    const c = parseMoney(splitText);
    if (c === null || c < 0) { setSplitText(centsToInput(split)); return; }
    setSplit(c);
  }

  return (
    <section className="acc-section" style={{ opacity: a.archived ? 0.6 : 1 }}>
      <button className="acc-head" aria-expanded={open} onClick={onToggle}>
        <AccIcon color={a.color} name={a.kind === 'external' ? 'send' : 'bank'} />
        <span className="grow">
          <b className="block">{a.name}</b>
          <span className="small muted">
            {isPay ? 'Pay lands here' : a.kind === 'external' ? 'Sent elsewhere' : `${items.length} cost${items.length === 1 ? '' : 's'}`}
            {a.archived ? ' · archived' : ''}
          </span>
        </span>
        {!isPay && (
          <span className="right">
            <b className="num">{cash(periodSends)}</b>
            {mode !== 'fixed' && <span className="small muted block">{mode === 'smooth' ? 'steady' : 'exact'}</span>}
          </span>
        )}
        <Chevron />
      </button>

      {open && (
        <div className="acc-body">
          <div className="form-grid">
            <label className="field">Name
              <input value={a.name} onChange={(e) => set('name', e.target.value)} />
            </label>
            <label className="field">Type
              <select value={a.kind} onChange={(e) => set('kind', e.target.value as Account['kind'])}>
                <option value="bank">My bank account</option>
                <option value="external">Sent elsewhere (card, person, fund)</option>
              </select>
            </label>
            <label className="field">Group
              <select value={a.groupId} onChange={(e) => set('groupId', e.target.value)}>
                {budget.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </label>
            <ColorPicker value={a.color} onChange={(c) => set('color', c)} />
          </div>

          {!isPay && (
            <div className="stack gap-8">
              <span className="small muted">Each payday, send</span>
              <div className="seg" role="group" aria-label="Payday amount" style={{ alignSelf: 'flex-start' }}>
                {!balanced && <button aria-pressed={mode === 'fixed'} onClick={() => setMode('fixed')}>Fixed amount</button>}
                {bills.length > 0 && <button aria-pressed={mode === 'smooth'} onClick={() => setMode('smooth')}>Steady</button>}
                {items.length > 0 && balanced !== 'smooth' && <button aria-pressed={mode === 'exact'} onClick={() => setMode('exact')}>Exact each pay</button>}
              </div>
              {balanced && (
                <p className="small muted">
                  {balanced === 'smooth'
                    ? 'Every cost here is weekly, so it gets a steady amount: the same most pays, with 4-week pays covering the 5th week.'
                    : bills.length === 0
                      ? 'Each payday sends what\u2019s put aside here, so it follows the amounts below rather than a fixed amount.'
                      : 'This account has bills on set dates, so each pay is worked out from them rather than a fixed amount.'}
                  {periodSends !== (mode === 'smooth' ? steady : periodNeed) && mode !== 'fixed' ? ` The pay being viewed sends ${cash(periodSends)}.` : ''}
                </p>
              )}

              {mode === 'fixed' && (
                <>
                  <label className="field" style={{ maxWidth: 260 }}>Sent here each payday (NZD)
                    <input inputMode="decimal" value={splitText} onChange={(e) => setSplitText(e.target.value)}
                      onBlur={commitSplit} onKeyDown={(e) => e.key === 'Enter' && commitSplit()} />
                  </label>
                  {items.length > 0 && (
                    <div className="tip">
                      <Icon name="bulb" />
                      <span>
                        This period ({periodDays} days) needs <b>{cash(periodNeed)}</b>. On average it needs <b>{cash(avgNeed)}</b> a month.
                        {!hasBalance && periodNeed > split && ` Sending ${cash(split)} leaves it ${cash(periodNeed - split)} short.`}
                      </span>
                    </div>
                  )}
                  {items.length > 0 && items.every((i) => i.frequency === 'weekly') && (
                    <div className="tip wrap" style={{ alignItems: 'center' }}>
                      <Icon name="bulb" />
                      <span style={{ flex: '1 1 220px' }}>
                        A fixed amount goes short in 5-week pays and builds up in 4-week ones. <b>Steady</b> evens it out: about <b>{cash(Math.ceil(avgNeed / 100) * 100)}</b> every pay, with 4-week pays leaving enough over for the 5th week.
                      </span>
                      <button className="btn small primary" onClick={() => setMode('smooth')}>Even it out: use Steady</button>
                    </div>
                  )}
                </>
              )}

              {mode === 'smooth' && (
                <div className="tip">
                  <Icon name="bulb" />
                  <span>
                    {steady === Math.ceil(avgNeed / 100) * 100
                      ? <>Sends <b>{cash(steady)}</b> every payday.</>
                      : <>Sends <b>{cash(steady)}</b> next payday, then usually <b>{cash(Math.ceil(avgNeed / 100) * 100)}</b>. {steady > avgNeed ? 'The extra covers earlier transfers and leaves enough for the next 5-week pay, so later pays stay level.' : 'A little less while there\u2019s extra in the account.'}</>}
                    {' '}4-week periods leave a little over that covers the 5th week, so the account never goes below $0.
                    {hasBalance
                      ? ' Worked out from the balance in Accounts, and it updates when you change it.'
                      : <> Add this account's balance in <a href="#/accounts">Accounts</a> for an exact figure.</>}
                  </span>
                </div>
              )}

              {mode === 'exact' && (
                <div className="tip">
                  <Icon name="bulb" />
                  <span>
                    {asides.length > 0 ? (() => {
                      const next = shiftPeriod(periodContaining(today, budget.settings), 1, budget.settings);
                      const each = asides.map((i) => `${i.name} ${cash(setAsidePerPay(i))}`).join(' + ');
                      return bills.length === 0
                        ? <>Puts <b>{cash(asidePerPay)}</b> aside each payday ({each}). It stays in the account until you need it, so the balance builds up, and what's built up never lowers what payday sends.</>
                        : <>Sends what each pay's bills need, plus <b>{cash(asidePerPay)}</b> put aside for {asideNames(budget, a.id)}. Next pay ({fmtShort(next.start)}) that's <b>{cash(depositFor(budget, a.id, next, today))}</b>. What's put aside stays in the account and is never counted towards the bills.</>;
                    })() : topsUp(budget, a.id) ? (() => {
                      const next = shiftPeriod(periodContaining(today, budget.settings), 1, budget.settings);
                      const sends = depositFor(budget, a.id, next, today);
                      const bills = exactNeed(budget, a.id, next);
                      return <>Sends what each pay's bills need, <b>less whatever is already left in the account</b>. Next pay ({fmtShort(next.start)}): bills {cash(bills)}{bills > sends ? `, ${cash(bills - sends)} already there` : ''}, so it sends <b>{cash(sends)}</b>.</>;
                    })() : <>Sends exactly what each period needs. This period ({periodDays} days) that's <b>{cash(periodNeed)}</b>, averaging <b>{cash(avgNeed)}</b> a month.</>}
                  </span>
                </div>
              )}
            </div>
          )}

          {(a.kind === 'bank' || items.length > 0) && (
            <div>
              <div className="card-head" style={{ marginBottom: 4 }}>
                <h3 className="h3">{asides.length === 0 ? 'Costs paid from here' : bills.length ? 'Costs and money put aside' : 'Money put aside here'}</h3>
                <button className="btn small" onClick={onAddItem}><Icon name="plus" size={16} /> Add cost</button>
              </div>
              {items.length === 0 && <p className="small muted">No costs yet.</p>}
              {items.map((i) => {
                const kept = isSetAside(i);
                const next = kept ? undefined : itemDates(i, today, '2100-01-01', budget.settings)[0];
                return (
                  <button key={i.id} className="list-row" onClick={() => onEditItem(i)}>
                    <span className="grow">
                      {i.name}
                      <span className="small muted block">
                        {kept
                          ? `${FREQ_LABEL[i.frequency]} · put aside, ${cash(setAsidePerPay(i))} a pay${i.end && i.end < today ? ' · stopped' : i.start > today ? ` · from ${fmtShort(i.start)}` : ''}`
                          : <>
                            {FREQ_LABEL[i.frequency]}{next ? ` · next ${fmtShort(next)}` : ' · finished'}
                            {i.frequency !== 'once' && i.frequency !== 'monthly' ? ` · ${cash(convert(i.amount, i.frequency, 'month'))}/mo avg` : ''}
                          </>}
                        {i.note ? ` · ${i.note}` : ''}
                      </span>
                    </span>
                    <b>{cash(i.amount)}</b>
                    <Icon name="edit" size={16} />
                  </button>
                );
              })}
            </div>
          )}

          {!isPay && (
            <div className="row">
              <button className="btn small ghost" onClick={() => set('archived', !a.archived)}>{a.archived ? 'Restore account' : 'Archive account'}</button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

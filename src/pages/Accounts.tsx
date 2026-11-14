import { useEffect, useState } from 'react';
import { AccountHistoryList, OneOffCostModal } from '../components/AccountHistory';
import { DayPicker, useDayView } from '../components/DayPicker';
import { Icon } from '../components/Icon';
import { MonthTracker, PayProjectionView } from '../components/MonthTracker';
import { fmtDay, fmtShort, monthName, todayISO } from '../lib/dates';
import { accountMode, balanceOn, balanceToday, depositFor, forecastBalances, outflows, smoothAmount } from '../lib/balances';
import { periodContaining, type Period } from '../lib/engine';
import { cash, centsToInput, parseMoney } from '../lib/money';
import { AccIcon, Chevron, Collapse, Disclosure, PageHead } from '../components/ui';
import { setBalance } from '../lib/history';
import { newId, useBudget } from '../lib/store';
import type { Account } from '../lib/types';

/** Balances: what's in each account, what it's for before next payday, and where it's heading. */
export function Accounts() {
  const { budget } = useBudget();
  // Keep "today" live: re-render when the date ticks over while the page is open.
  const [, setDay] = useState(todayISO());
  useEffect(() => { const t = setInterval(() => setDay(todayISO()), 60000); return () => clearInterval(t); }, []);
  const managed = new Set((budget.savings ?? []).map((g) => g.accountId));
  // The pay account (e.g. Weekly allowance) only passes pay on to the others on payday, so it isn't tracked here.
  const payAcc = budget.accounts.find((a) => a.id === budget.settings.payAccountId);
  const accounts = budget.accounts.filter((a) => a.kind === 'bank' && !a.archived && !managed.has(a.id) && a.id !== budget.settings.payAccountId);
  const today = todayISO();
  const period = periodContaining(today, budget.settings);
  // Which pay and day to look at: today in the pay you're in now, by default.
  const dv = useDayView('paydays.accounts.view');
  const { view, day, offset } = dv;
  const live = dv.isToday;
  const dayIdx = dv.dayIdx;
  const goPay = dv.goPay;

  // Estimated total on the chosen day, across accounts whose balance can be worked out. Today: before
  // today's payments come out, the same figure as each card's headline, so the cards add up to it.
  const onDay = accounts.map((a) => ({ a, v: live ? balanceToday(budget, a.id, today) : balanceOn(budget, a.id, day, today) })).filter((x) => x.v !== undefined);
  const known = onDay.map((x) => x.a);
  const total = onDay.reduce((t, x) => t + (x.v ?? 0), 0);

  return (
    <>
      <PageHead title="Accounts" sub={`What's in each account and what it's for, up to next pay on ${fmtDay(period.nextPayday)}. Update a balance whenever you check your banking app.`} />

      <DayPicker dv={dv} />

      {known.length > 0 && (
        <section className="stats">
          <div className="stat">
            <span className="small muted">{live ? `Across ${known.length} account${known.length === 1 ? '' : 's'}` : `Estimated on ${fmtDay(day)}`}</span>
            <b>{cash(total)}</b>
            {!live && <span className="small muted">across {known.length} account{known.length === 1 ? '' : 's'}{known.length < accounts.length ? ` (${accounts.length - known.length} without a balance)` : ''}</span>}
          </div>
          {live
            ? <div className="stat"><span className="small muted">Next pay</span><b>{fmtShort(period.nextPayday)}</b><span className="small muted">in {Math.max(0, Math.round((Date.parse(period.nextPayday) - Date.parse(today)) / 86400000))} days</span></div>
            : <div className="stat"><span className="small muted">{`${monthName(view.start)} pay${offset === 0 ? ' (this pay)' : ''}`}</span><b>{fmtShort(view.start)} – {fmtShort(view.end)}</b><span className="small muted">day {dayIdx + 1} of {view.days}</span></div>}
        </section>
      )}

      <div className="cards-2">
        {accounts.map((a) => <BalanceCard key={a.id} account={a} view={live ? undefined : view} day={day} onPick={(i) => { goPay(i); window.scrollTo({ top: 0, behavior: 'smooth' }); }} />)}
      </div>

      <p className="note">
        {payAcc ? `${payAcc.name} isn't shown: pay lands there and is sent on to these accounts on payday. ` : ''}Savings balances are kept with their goals in <a href="#/savings">Savings</a>. What payday sends to each account is set in <a href="#/deposits">Deposits</a>.
      </p>
    </>
  );
}

function BalanceCard({ account: a, view, day, onPick }: { account: Account; view?: Period; day: string; onPick: (offset: number) => void }) {
  const { budget, update } = useBudget();
  const today = todayISO();
  const s = budget.settings;
  const entry = budget.balances?.[a.id];
  const [editing, setEditing] = useState(false);
  const [costing, setCosting] = useState(false);
  // The payments behind the figures are a click away; open or closed is remembered per account.
  const openKey = `paydays.accounts.open.${a.id}`;
  const [open, setOpenState] = useState(() => { try { return localStorage.getItem(openKey) === 'open'; } catch { return false; } });
  const setOpen = (v: boolean) => { setOpenState(v); try { localStorage.setItem(openKey, v ? 'open' : 'closed'); } catch { /* ignore */ } };
  const [text, setText] = useState(entry ? centsToInput(entry.amount) : '');
  const [err, setErr] = useState('');
  const isPay = a.id === s.payAccountId;
  const mode = accountMode(budget, a.id);

  // Today: what's in the account before today's payments come out, the same figure as the tracker's
  // "In the account" (a bill dated today may not have left the bank yet, so it's still to come).
  const now = balanceToday(budget, a.id, today);
  const shown = view ? balanceOn(budget, a.id, day, today) : now;
  const dueToday = !view && outflows(budget, a.id, today, today).length > 0;

  const forecast = entry && !isPay ? forecastBalances(budget, a.id, 6, today) : [];
  const lowest = forecast.reduce<number | undefined>((m, r) => (r.end === undefined ? m : m === undefined ? r.end : Math.min(m, r.end)), undefined);
  const tracked = !isPay && budget.items.some((i) => i.accountId === a.id);
  const history = budget.accountHistory?.[a.id] ?? [];
  const hasHistory = history.length > 0;
  // One-off costs recorded since you last entered the balance (they've been taken off it).
  const costsSince = history.slice(history.map((e) => e.kind).lastIndexOf('balance') + 1)
    .reduce((t, e) => t + (e.kind === 'cost' ? e.amount : 0), 0);

  function save() {
    const c = parseMoney(text);
    if (c === null) return setErr('Enter the balance, like 705.00');
    update((b) => { setBalance(b, a.id, c, today, newId()); return b; });
    setEditing(false); setErr('');
  }

  const modeText = isPay ? 'Pay lands here'
    : mode === 'smooth' ? `Steady · ${cash(view ? depositFor(budget, a.id, view, today) : smoothAmount(budget, a.id))} ${view ? `on ${fmtShort(view.start)}` : 'next pay'}`
    : mode === 'exact' ? 'Exact amount each pay'
    : `${cash(budget.split.find((l) => l.accountId === a.id)?.amount ?? 0)} each pay`;

  return (
    <section className="card stack gap-12">
      <div className="between nowrap top">
        <div className="row min0">
          <AccIcon color={a.color} name={isPay ? 'wallet' : 'bank'} />
          <div className="min0">
            <h2 className="h2">{a.name}</h2>
            <p className="small muted">{modeText}</p>
          </div>
        </div>
        {shown !== undefined && !editing && (
          <div className="right">
            <b className={`fig ${shown < 0 ? 'neg' : ''}`}>{cash(shown)}</b>
            <span className="small muted block">{view ? `${day > today ? 'estimated' : 'on'} ${fmtShort(day)}` : entry!.asOf === today ? 'today' : dueToday ? "estimated, before today's bills" : 'estimated now'}</span>
          </div>
        )}
      </div>

      {(editing || !entry) && (
        <div className="row wrap bottom">
          <label className="field" style={{ flex: '1 1 180px', maxWidth: 260 }}>Balance right now
            <input inputMode="decimal" value={text} autoFocus={editing} placeholder="0.00"
              onChange={(e) => { setText(e.target.value); setErr(''); }} onKeyDown={(e) => e.key === 'Enter' && save()} />
          </label>
          <button className="btn primary" onClick={save}>Save balance</button>
          {editing && <button className="btn" onClick={() => setEditing(false)}>Cancel</button>}
          {err && <p className="error" role="alert" style={{ width: '100%' }}>{err}</p>}
        </div>
      )}

      {tracked && (view
        ? <PayProjectionView budget={budget} account={a} period={view} day={day} today={today} open={open} />
        : <MonthTracker budget={budget} account={a} today={today} open={open} />)}

      <Collapse open={open} stacked>
      <div className="stack gap-12">
      {forecast.length > 0 && (
        <Disclosure title="Next 6 pays" meta={lowest !== undefined ? `lowest ${cash(lowest)}` : undefined}>
          <div className="table-scroll">
            <table className="table">
              <thead><tr><th>Pay</th><th>In</th><th>Out</th><th>Ends with</th></tr></thead>
              <tbody>
                {forecast.map((r, i) => (
                  <tr key={r.period.start} role="button" tabIndex={0} title="See this pay day by day" style={{ cursor: 'pointer' }}
                    className={view?.start === r.period.start ? 'picked' : undefined}
                    onClick={() => onPick(i)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onPick(i)}>
                    <td>{monthName(r.period.start).slice(0, 3)} {r.period.start.slice(2, 4)}</td>
                    <td>{r.deposit ? cash(r.deposit, { whole: true }) : '—'}</td>
                    <td>{cash(r.out, { whole: true })}</td>
                    <td><b className={r.end !== undefined && r.end < 0 ? 'neg' : ''}>{r.end !== undefined ? cash(r.end, { whole: true }) : '—'}</b></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Disclosure>
      )}

      <AccountHistoryList account={a} />

      {entry && !editing && (
        <p className="small muted">
          {`You entered ${cash(entry.amount + costsSince)} ${entry.asOf === today ? 'today' : `on ${fmtShort(entry.asOf)}`}`}
          {costsSince ? `, less ${cash(costsSince)} of one-off costs since` : ''}.
          {entry.asOf !== today && ` Payments and paydays since then are counted in the estimate${dueToday ? "; today's bills are still to come" : ''}.`}
        </p>
      )}
      </div>
      </Collapse>

      {entry && !editing && (
        <div className="between nowrap">
          {tracked || forecast.length > 0 || hasHistory
            ? <button type="button" className="disc-head" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide details' : 'Details'}<Chevron size={16} /></button>
            : <span />}
          <span className="row nowrap gap-6">
            <button className="icon-btn sm has-tip" data-tip="Update balance" aria-label={`Update ${a.name} balance`}
              onClick={() => { setText(centsToInput(now ?? entry.amount)); setEditing(true); }}>
              <Icon name="edit" size={16} />
            </button>
            <button className="btn small" onClick={() => setCosting(true)}><Icon name="receipt" size={16} /> One-off cost</button>
          </span>
        </div>
      )}
      {costing && <OneOffCostModal account={a} onClose={() => setCosting(false)} />}
    </section>
  );
}

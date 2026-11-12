import { useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { DayPicker, useDayView } from '../components/DayPicker';
import { MonthTracker, PayProjectionView } from '../components/MonthTracker';
import { fmtDay, fmtShort, monthName, todayISO } from '../lib/dates';
import { accountMode, balanceOn, depositFor, estimateBalance, forecastBalances, smoothAmount } from '../lib/balances';
import { periodContaining, type Period } from '../lib/engine';
import { centsToInput, money, parseMoney } from '../lib/money';
import { useBudget } from '../lib/store';
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

  // Estimated total on the chosen day, across accounts whose balance can be worked out.
  const onDay = accounts.map((a) => ({ a, v: live ? estimateBalance(budget, a.id, today) : balanceOn(budget, a.id, day, today) })).filter((x) => x.v !== undefined);
  const known = onDay.map((x) => x.a);
  const total = onDay.reduce((t, x) => t + (x.v ?? 0), 0);

  return (
    <>
      <header>
        <h1 className="h1">Accounts</h1>
        <p className="small muted">
          What's in each account and what it's for, up to next pay on {fmtDay(period.nextPayday)}. Update a balance whenever you check your banking app.
        </p>
      </header>

      {known.length > 0 && (
        <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
          <div className="stat" style={{ background: 'var(--card)' }}>
            <span className="small muted">{live ? `Across ${known.length} account${known.length === 1 ? '' : 's'}` : `Estimated on ${fmtDay(day)}`}</span>
            <b>{money(total)}</b>
            {!live && <span className="small muted">across {known.length} account{known.length === 1 ? '' : 's'}{known.length < accounts.length ? ` (${accounts.length - known.length} without a balance)` : ''}</span>}
          </div>
          {live
            ? <div className="stat" style={{ background: 'var(--card)' }}><span className="small muted">Next pay</span><b>{fmtShort(period.nextPayday)}</b><span className="small muted">in {Math.max(0, Math.round((Date.parse(period.nextPayday) - Date.parse(today)) / 86400000))} days</span></div>
            : <div className="stat" style={{ background: 'var(--card)' }}><span className="small muted">{`${monthName(view.start)} pay${offset === 0 ? ' (this pay)' : ''}`}</span><b>{fmtShort(view.start)} – {fmtShort(view.end)}</b><span className="small muted">day {dayIdx + 1} of {view.days}</span></div>}
        </section>
      )}

      <DayPicker dv={dv} />

      {accounts.map((a) => <BalanceCard key={a.id} account={a} view={live ? undefined : view} day={day} onPick={(i) => { goPay(i); window.scrollTo({ top: 0, behavior: 'smooth' }); }} />)}

      <div className="tip">
        <Icon name="bulb" />
        <span>{payAcc ? `${payAcc.name} isn't shown: pay lands there and is sent on to these accounts on payday. ` : ''}Savings balances are kept with their goals in <a href="#/savings">Savings</a>. What payday sends to each account is set in <a href="#/deposits">Deposits</a>.</span>
      </div>
    </>
  );
}

function BalanceCard({ account: a, view, day, onPick }: { account: Account; view?: Period; day: string; onPick: (offset: number) => void }) {
  const { budget, update } = useBudget();
  const today = todayISO();
  const s = budget.settings;
  const entry = budget.balances?.[a.id];
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(entry ? centsToInput(entry.amount) : '');
  const [err, setErr] = useState('');
  const isPay = a.id === s.payAccountId;
  const mode = accountMode(budget, a.id);

  const now = estimateBalance(budget, a.id, today);
  const shown = view ? balanceOn(budget, a.id, day, today) : now;

  const forecast = entry && !isPay ? forecastBalances(budget, a.id, 6, today) : [];
  const lowest = forecast.reduce<number | undefined>((m, r) => (r.end === undefined ? m : m === undefined ? r.end : Math.min(m, r.end)), undefined);

  function save() {
    const c = parseMoney(text);
    if (c === null) return setErr('Enter the balance, like 705.00');
    update((b) => { b.balances = { ...(b.balances ?? {}), [a.id]: { amount: c, asOf: today } }; return b; });
    setEditing(false); setErr('');
  }

  const modeText = isPay ? 'Pay lands here'
    : mode === 'smooth' ? `Steady · ${money(view ? depositFor(budget, a.id, view, today) : smoothAmount(budget, a.id))} ${view ? `on ${fmtShort(view.start)}` : 'next pay'}`
    : mode === 'exact' ? 'Exact amount each pay'
    : `${money(budget.split.find((l) => l.accountId === a.id)?.amount ?? 0)} each pay`;

  return (
    <section className="card" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="between" style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}>
        <div className="row" style={{ minWidth: 0 }}>
          <span className="acc-icon" style={{ background: a.color }}><Icon name={isPay ? 'wallet' : 'bank'} /></span>
          <div style={{ minWidth: 0 }}>
            <h2 className="h2">{a.name}</h2>
            <p className="small muted">{modeText}</p>
          </div>
        </div>
        {shown !== undefined && !editing && (
          <div style={{ textAlign: 'right' }}>
            <b style={{ fontSize: 22 }} className={shown < 0 ? 'neg' : ''}>{money(shown)}</b>
            <span className="small muted" style={{ display: 'block' }}>{view ? `${day > today ? 'estimated' : 'on'} ${fmtShort(day)}` : entry!.asOf === today ? 'today' : 'estimated now'}</span>
          </div>
        )}
      </div>

      {editing || !entry ? (
        <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label className="field" style={{ flex: '1 1 180px', maxWidth: 260 }}>Balance right now
            <input inputMode="decimal" value={text} autoFocus={editing} placeholder="0.00"
              onChange={(e) => { setText(e.target.value); setErr(''); }} onKeyDown={(e) => e.key === 'Enter' && save()} />
          </label>
          <button className="btn primary" onClick={save}>Save balance</button>
          {editing && <button className="btn" onClick={() => setEditing(false)}>Cancel</button>}
          {err && <p className="error" role="alert" style={{ width: '100%' }}>{err}</p>}
        </div>
      ) : (
        <div className="between small">
          <span className="muted">
            You entered {money(entry.amount)} on {fmtShort(entry.asOf)}
            {entry.asOf !== today ? '. Payments and paydays since then are counted in the estimate.' : '.'}
          </span>
          <button className="btn small" onClick={() => { setText(centsToInput(now ?? entry.amount)); setEditing(true); }}>Update balance</button>
        </div>
      )}

      {!isPay && budget.items.some((i) => i.accountId === a.id) && (view
        ? <PayProjectionView budget={budget} account={a} period={view} day={day} today={today} />
        : <MonthTracker budget={budget} account={a} today={today} />)}

      {forecast.length > 0 && (
        <details>
          <summary className="small" style={{ cursor: 'pointer', minHeight: 32, fontWeight: 600 }}>
            Next 6 pays{lowest !== undefined ? ` · lowest ${money(lowest)}` : ''}
          </summary>
          <div style={{ marginTop: 6 }}>
            <div className="list-row small muted" style={{ paddingTop: 4 }}>
              <span style={{ flex: 1 }}>Pay</span><span style={{ width: 80, textAlign: 'right' }}>In</span><span style={{ width: 80, textAlign: 'right' }}>Out</span><span style={{ width: 90, textAlign: 'right' }}>Ends with</span>
            </div>
            {forecast.map((r, i) => (
              <div className="list-row small" key={r.period.start} role="button" tabIndex={0} title="See this pay day by day"
                style={{ cursor: 'pointer', background: view?.start === r.period.start ? 'var(--soft)' : undefined }}
                onClick={() => onPick(i)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onPick(i)}>
                <span style={{ flex: 1 }}>{monthName(r.period.start).slice(0, 3)} {r.period.start.slice(2, 4)}</span>
                <span style={{ width: 80, textAlign: 'right' }}>{r.deposit ? money(r.deposit, { whole: true }) : '—'}</span>
                <span style={{ width: 80, textAlign: 'right' }}>{money(r.out, { whole: true })}</span>
                <b style={{ width: 90, textAlign: 'right' }} className={r.end !== undefined && r.end < 0 ? 'neg' : ''}>{r.end !== undefined ? money(r.end, { whole: true }) : '—'}</b>
              </div>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

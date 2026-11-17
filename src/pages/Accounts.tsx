import { SyncPill } from '../components/SyncPill';
import { useEffect, useState } from 'react';
import { AccountHistoryList } from '../components/AccountHistory';
import { AccountEditModal } from '../components/AccountEdit';
import { TransactionList } from '../components/Transactions';
import { DayPicker, useDayView } from '../components/DayPicker';
import { Icon } from '../components/Icon';
import { MonthTracker, PayProjectionView } from '../components/MonthTracker';
import { addDays, fmtDay, fmtShort, monthName, todayISO } from '../lib/dates';
import { balanceOn, balanceToday, depositFor, forecastBalances, outflows } from '../lib/balances';
import { periodContaining, shiftPeriod, type Period } from '../lib/engine';
import { cash, parseMoney } from '../lib/money';
import { moveAmong } from '../lib/order';
import { AccIcon, CardColumns, Collapse, DetailsToggle, Disclosure, MoveButtons, ReorderToggle, useFlip, FlatDetails } from '../components/ui';
import { bankSync } from '../lib/bank';
import { setBalance } from '../lib/history';
import { newId, useBudget } from '../lib/store';
import type { Account } from '../lib/types';
import { DepositsModal } from './Deposits';

/** Balances: what's in each account, what it's for before next payday, and where it's heading. */
export function Accounts({ deposits }: { deposits?: string }) {
  const { budget, update } = useBudget();
  // Keep "today" live: re-render when the date ticks over while the page is open.
  const [, setDay] = useState(todayISO());
  useEffect(() => { const t = setInterval(() => setDay(todayISO()), 60000); return () => clearInterval(t); }, []);
  // Deposits opens over the page: from its button, or a link to #/accounts/deposits/<account>.
  const [depOpen, setDepOpen] = useState<string | undefined>(deposits);
  useEffect(() => { if (deposits !== undefined) setDepOpen(deposits); }, [deposits]);
  const closeDeposits = () => {
    setDepOpen(undefined);
    if (/deposits/.test(window.location.hash)) history.replaceState(null, '', '#/accounts');
  };
  const [reorder, setReorder] = useState(false);

  const goals = budget.savings ?? [];
  const managed = new Set(goals.map((g) => g.accountId));
  const payId = budget.settings.payAccountId;
  // Balance cards: your bank accounts whose balance is planned around (not the pay account, not a goal's).
  const isPlanned = (a: Account) => a.kind === 'bank' && !managed.has(a.id) && a.id !== payId;
  // Every account shown, in your order: planned ones, and the pay account or a goal's with transactions.
  const shown = budget.accounts.filter((a) => !a.archived && (isPlanned(a) || a.id === payId || !!budget.accountTransactions?.[a.id]?.length));
  const accounts = shown.filter(isPlanned);
  const order = shown.map((a) => a.id);
  const flip = useFlip(order.join());
  const move = (id: string, dir: -1 | 1) => { flip.capture(); update((b) => { moveAmong(b.accounts, order, id, dir); return b; }); };

  const today = todayISO();
  const period = periodContaining(today, budget.settings);
  // Which pay and day to look at: today in the pay you're in now, by default.
  const dv = useDayView('paydays.accounts.view');
  const { view, day, offset } = dv;
  const live = dv.isToday;

  // Estimated total on the chosen day, across accounts whose balance can be worked out. Today: before
  // today's payments come out, the same figure as each card's headline, so the cards add up to it.
  const onDay = accounts.map((a) => ({ a, v: live ? balanceToday(budget, a.id, today) : balanceOn(budget, a.id, day, today) })).filter((x) => x.v !== undefined);
  const known = onDay.map((x) => x.a);
  const total = onDay.reduce((t, x) => t + (x.v ?? 0), 0);

  return (
    <>
      <DayPicker dv={dv} title="Accounts">
        <div className="page-actions">
          <ReorderToggle on={reorder} onChange={setReorder} />
          <button className="btn primary" onClick={() => setDepOpen('')}><Icon name="transfer" size={16} /> Deposits</button>
        </div>
      </DayPicker>

      {known.length > 0 && (
        <section className="stats">
          <div className="stat">
            <span className="small muted">{live ? `Across ${known.length} account${known.length === 1 ? '' : 's'}` : `Estimated on ${fmtDay(day)}`}</span>
            <b>{cash(total)}</b>
            {!live && <span className="small muted">across {known.length} account{known.length === 1 ? '' : 's'}{known.length < accounts.length ? ` (${accounts.length - known.length} without a balance)` : ''}</span>}
          </div>
          {live
            ? <div className="stat"><span className="small muted">Next pay</span><b>{fmtShort(period.nextPayday)}</b><span className="small muted">in {Math.max(0, Math.round((Date.parse(period.nextPayday) - Date.parse(today)) / 86400000))} days</span></div>
            : <div className="stat"><span className="small muted">{`${monthName(view.start)} pay${offset === 0 ? ' (this pay)' : ''}`}</span><b>{fmtShort(view.start)} – {fmtShort(view.end)}</b><span className="small muted">day {dv.dayIdx + 1} of {view.days}</span></div>}
        </section>
      )}

      <CardColumns innerRef={flip.ref} className={reorder ? 'reordering' : undefined}>
        {shown.map((a, i) => {
          const mover = reorder ? <MoveButtons name={a.name} first={i === 0} last={i === shown.length - 1} onMove={(d) => move(a.id, d)} /> : null;
          return isPlanned(a)
            ? <BalanceCard key={a.id} account={a} view={live ? undefined : view} day={day} mover={mover}
              onPick={(n) => { dv.goPay(n); window.scrollTo({ top: 0, behavior: 'smooth' }); }} />
            : <BankOnlyCard key={a.id} account={a} mover={mover} />;
        })}
      </CardColumns>

      {depOpen !== undefined && <DepositsModal openId={depOpen || undefined} onClose={closeDeposits} />}
    </>
  );
}

/** Typing in a balance, in place of the figure. */
function BalanceInput({ initial, onSave, onCancel }: { initial: string; onSave: (cents: number) => void; onCancel?: () => void }) {
  const [text, setText] = useState(initial);
  const [err, setErr] = useState('');
  function save() {
    const c = parseMoney(text);
    if (c === null) return setErr('Enter the balance, like 705.00');
    onSave(c);
  }
  return (
    <div className="stack gap-6">
      <div className="row nowrap gap-8">
        <input className="input" style={{ maxWidth: 200 }} inputMode="decimal" value={text} autoFocus={!!onCancel} placeholder="0.00" aria-label="Balance right now"
          onChange={(e) => { setText(e.target.value); setErr(''); }} onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') onCancel?.(); }} />
        <button className="btn primary small" onClick={save}>Save</button>
        {onCancel && <button className="btn small ghost" onClick={onCancel}>Cancel</button>}
      </div>
      {err && <p className="error" role="alert">{err}</p>}
    </div>
  );
}

function BalanceCard({ account: a, view, day, mover, onPick }: {
  account: Account; view?: Period; day: string; mover: React.ReactNode; onPick: (offset: number) => void;
}) {
  const { budget, update } = useBudget();
  const today = todayISO();
  const entry = budget.balances?.[a.id];
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(false); // every card starts closed
  const sync = bankSync(budget, `account:${a.id}`);

  // Today: what's in the account before today's payments come out, the same figure as the tracker's
  // "In the account" (a bill dated today may not have left the bank yet, so it's still to come).
  const now = balanceToday(budget, a.id, today);
  const shown = view ? balanceOn(budget, a.id, day, today) : now;
  const dueToday = !view && outflows(budget, a.id, today, today).length > 0;
  const estimated = !view && entry && entry.asOf !== today;

  const forecast = entry ? forecastBalances(budget, a.id, 6, today) : [];
  const lowest = forecast.reduce<number | undefined>((m, r) => (r.end === undefined ? m : m === undefined ? r.end : Math.min(m, r.end)), undefined);
  const tracked = budget.items.some((i) => i.accountId === a.id);
  const hasHistory = (budget.accountHistory?.[a.id] ?? []).length > 0;
  const txns = budget.accountTransactions?.[a.id] ?? [];
  const hasDetails = tracked || forecast.length > 0 || hasHistory || txns.length > 0;

  // What payday sends here: next pay's, or the pay being looked at.
  const pay = view ?? shiftPeriod(periodContaining(today, budget.settings), 1, budget.settings);
  const sends = depositFor(budget, a.id, pay, today);

  return (
    <section className={`card acct${open ? ' open' : ''}`} data-flip={a.id}>
      <div className="acct-head">
        <AccIcon color={a.color} name="bank" />
        <div className="grow min0">
          <h2 className="h2 clip">{a.name}</h2>
          <p className="small muted clip">+{cash(sends)} on {fmtShort(pay.start)}</p>
        </div>
        <div className="acct-side">
          {entry && <SyncPill source={sync.linked ? 'bank' : 'entered'} at={sync.at ?? entry.asOf} />}
          {mover ?? <button className="icon-btn mini has-tip tip-left" data-tip="Edit" aria-label={`Edit ${a.name}: balance, one-off cost, payday`} onClick={() => setEditing(true)}><Icon name="edit" size={14} /></button>}
        </div>
      </div>

      {!entry ? (
        <BalanceInput initial="" onSave={(c) => { update((b) => { setBalance(b, a.id, c, today, newId()); return b; }); }} />
      ) : (
        <div className="acct-fig">
          <b className={`fig ${shown !== undefined && shown < 0 ? 'neg' : ''}`}>{shown !== undefined ? cash(shown) : '—'}</b>
          {(view || estimated) && (
            <span className="xs muted note-line">
              {view ? `${day > today ? 'Estimated' : 'On'} ${fmtShort(day)}` : `Estimated from ${fmtShort(entry.asOf)}${dueToday ? ", before today's bills" : ''}`}
            </span>
          )}
        </div>
      )}

      {tracked && (view
        ? <PayProjectionView budget={budget} account={a} period={view} day={day} today={today} open={open} />
        : <MonthTracker budget={budget} account={a} today={today} open={open} />)}

      <Collapse open={open} stacked><FlatDetails.Provider value>
        <div className="acct-body">
          {forecast.length > 0 && (
            <Disclosure title="Next 6 pays" meta={lowest !== undefined ? `lowest ${cash(lowest, { whole: true })}` : undefined}>
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
          <TransactionList items={txns} pending={budget.pendingTransactions?.[a.id]} />
        </div>
      </FlatDetails.Provider></Collapse>

      {entry && hasDetails && <DetailsToggle open={open} onChange={setOpen} />}
      {editing && <AccountEditModal account={a} onClose={() => setEditing(false)} />}
    </section>
  );
}

/**
 * An account whose balance isn't planned around: the one pay lands in, or a savings goal's. The same
 * card, with the bank's balance (or the goal's) and what's gone in and out.
 */
function BankOnlyCard({ account: a, mover }: { account: Account; mover: React.ReactNode }) {
  const { budget } = useBudget();
  const today = todayISO();
  const [open, setOpen] = useState(false); // every card starts closed
  const txns = budget.accountTransactions?.[a.id] ?? [];
  const isPay = a.id === budget.settings.payAccountId;
  const goal = (budget.savings ?? []).find((g) => g.accountId === a.id);
  const sync = bankSync(budget, `account:${a.id}`);
  const goalSync = goal ? bankSync(budget, `saving:${goal.id}`) : { linked: false };
  const bal = sync.linked ? budget.balances?.[a.id] : goal ? { amount: goal.balance, asOf: goal.asOf } : undefined;
  const month = addDays(today, -30);
  const spent = txns.filter((t) => t.amount < 0 && t.date > month).reduce((x, t) => x - t.amount, 0);
  const inn = txns.filter((t) => t.amount > 0 && t.date > month).reduce((x, t) => x + t.amount, 0);
  const latest = txns[txns.length - 1];

  return (
    <section className="card acct" data-flip={a.id}>
      <div className="acct-head">
        <AccIcon color={a.color} name={isPay ? 'wallet' : goal ? 'piggy' : 'bank'} />
        <div className="grow min0">
          <h2 className="h2 clip">{a.name}</h2>
          {goal
            ? <p className="small muted">Savings goal</p>
            : <p className="small muted">{isPay ? 'Pay lands here' : 'Not planned'}</p>}
        </div>
        <div className="acct-side">
          <SyncPill source={sync.linked || goalSync.linked ? 'bank' : bal ? 'entered' : 'none'} at={sync.at ?? goalSync.at ?? bal?.asOf} />
          {mover ?? (goal
            ? <a className="icon-btn mini has-tip tip-left" data-tip="Open in Savings" aria-label={`Open ${goal.name} in Savings`} href="#/savings"><Icon name="right" size={14} /></a>
            : <a className="icon-btn mini has-tip tip-left" data-tip="Spending in Insights" aria-label="Spending in Insights" href="#/insights"><Icon name="pie" size={14} /></a>)}
        </div>
      </div>

      <div className="acct-fig">
        <b className="fig">{bal ? cash(bal.amount) : '—'}</b>
        {!bal && <span className="xs muted note-line">{isPay ? 'Spent from day to day, so its balance isn’t kept.' : 'Balance not tracked.'}</span>}
      </div>

      {txns.length > 0 ? (
        <div className="trio">
          <div className="stat"><span className="small muted">Spent</span><b>{cash(spent, { whole: true })}</b><span className="xs muted">last 30 days</span></div>
          <div className="stat"><span className="small muted">In</span><b>{cash(inn, { whole: true })}</b><span className="xs muted">last 30 days</span></div>
          <div className="stat"><span className="small muted">Latest</span><b>{fmtShort(latest.date)}</b><span className="xs muted">{txns.length} transactions</span></div>
        </div>
      ) : <p className="small muted">Upload a statement or CSV export to see what goes in and out.</p>}

      <Collapse open={open} stacked><FlatDetails.Provider value>
        <div className="acct-body">
          <TransactionList items={txns} pending={budget.pendingTransactions?.[a.id]} first={10} />
        </div>
      </FlatDetails.Provider></Collapse>
      {txns.length > 0 && <DetailsToggle open={open} onChange={setOpen} />}
    </section>
  );
}

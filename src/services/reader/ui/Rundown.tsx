import { useEffect, useMemo, useState } from 'react';
import { addMonths, fmtShort, todayISO } from '../../../core/dates';
import { owed } from '../../../features/debts/logic/amounts';
import { planEnds } from '../../../features/debts/logic/gem';
import { cash } from '../../../core/money';
import { fingerprint, preview } from '../apply';
import { NEW_DEBT, NOT_MINE, type Draft, type DraftFig } from '../check/draft';
import { purchaseRows, resolvePlanRow, review } from '../check/review';
import { toCents } from '../check/figures';
import { useBudget } from '../../../state/store';
import { Icon } from '../../../ui/Icon';
import { BalancesCheck, KiwiSaverCheck, TransactionsCheck } from './RundownChecks';

/** An amount box: what was read, with the document's own label for it. */
export function Money({ label, fig, onChange, placeholder }: { label: string; fig: DraftFig; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className="field">{label}
      <input inputMode="decimal" value={fig.value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      {fig.label && <span className="xs muted">On the document: “{fig.label}”</span>}
    </label>
  );
}

export function Rundown({ draft, sourceLabel, onEdit, onCancel, cancelLabel, onConfirm }: {
  draft: Draft;
  sourceLabel: string;
  onEdit: (d: Draft) => void;
  onCancel: () => void;
  cancelLabel: string;
  onConfirm: (p: NonNullable<ReturnType<typeof review>['proposal']>, pv: ReturnType<typeof preview>) => void;
}) {
  const { budget } = useBudget();
  const today = todayISO();
  const r = useMemo(() => review(draft, budget, today), [draft, budget, today]);
  const pv = useMemo(() => (r.proposal ? preview(budget, r.proposal, today) : null), [r, budget, today]);
  const print = pv ? fingerprint(pv) : '';
  // What you were last shown. If the budget changes underneath (a sync), the rundown is shown again first.
  const [seen, setSeen] = useState(print);
  useEffect(() => { setSeen(print); /* your own edits count as seen */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);
  const stale = !!pv && seen !== print;
  const edit = (fn: (d: Draft) => void) => { const d = structuredClone(draft); fn(d); onEdit(d); };
  const blocks = r.issues.filter((i) => i.level === 'block');
  const notes = r.issues.filter((i) => i.level === 'note');
  const debts = (budget.debts ?? []).filter((d) => !d.payroll || d.kind === 'loan');
  const s = draft.statement;
  const debt = debts.find((d) => d.id === s.debtId);
  // Purchases on a card app screen that its rules make plans of their own (Gem: $250 or more).
  const buys = purchaseRows(draft, debt).filter((r) => r.months);
  const ap = (budget.debts ?? []).find((d) => d.id === draft.afterpay.debtId);

  return (
    <>
      <span className="pill" style={{ alignSelf: 'flex-start' }}>{sourceLabel}</span>
      {draft.kind !== 'transactions' && (
        <div className="seg" role="group" aria-label="What this is" style={{ alignSelf: 'flex-start' }}>
          {(['payslip', 'statement', 'balances', 'kiwisaver', 'afterpay'] as const).map((k) => (
            <button key={k} aria-pressed={draft.kind === k} onClick={() => edit((d) => { d.kind = k; })}>{k === 'payslip' ? 'Payslip' : k === 'statement' ? 'Card or loan' : k === 'balances' ? 'Bank balances' : k === 'kiwisaver' ? 'KiwiSaver' : 'Afterpay'}</button>
          ))}
        </div>
      )}

      {draft.kind === 'transactions' && <TransactionsCheck draft={draft} edit={edit} />}

      {draft.kind === 'payslip' && (
        <div className="form-grid">
          <Money label="Pay that reached you (net)" fig={draft.payslip.net} placeholder="4,000.00" onChange={(v) => edit((d) => { d.payslip.net.value = v; })} />
          <label className="field">Pay day
            <input type="date" value={draft.payslip.payDay} onChange={(e) => edit((d) => { d.payslip.payDay = e.target.value; })} />
          </label>
          <Money label="Student loan deduction" fig={draft.payslip.studentLoan} placeholder="0.00" onChange={(v) => edit((d) => { d.payslip.studentLoan.value = v; })} />
        </div>
      )}

      {draft.kind === 'statement' && (
        <>
          <label className="field">Which debt it’s for
            <select value={s.debtId} onChange={(e) => edit((d) => { d.statement.debtId = e.target.value; })}>
              {!s.debtId && <option value="">Choose…{s.nameOnDocument ? ` (it says “${s.nameOnDocument}”)` : ''}</option>}
              {debts.map((d) => <option key={d.id} value={d.id}>{d.name} (now {cash(owed(d))})</option>)}
              <option value={NEW_DEBT}>+ A new debt…</option>
            </select>
          </label>
          {s.debtId === NEW_DEBT && (
            <label className="field">Name of the new debt
              <input value={s.newName} placeholder="Gem Visa" onChange={(e) => edit((d) => { d.statement.newName = e.target.value; })} />
            </label>
          )}
          <div className="form-grid">
            <Money label="Owed" fig={s.balance} placeholder="1,240.50" onChange={(v) => edit((d) => { d.statement.balance.value = v; })} />
            <label className="field">{s.appScreen ? 'As at' : 'As at (statement date)'}
              <input type="date" value={s.date} max={today} onChange={(e) => edit((d) => { d.statement.date = e.target.value; })} />
            </label>
            {!debt?.payroll && <Money label="Credit limit (optional)" fig={s.limit} onChange={(v) => edit((d) => { d.statement.limit.value = v; })} />}
          </div>
          {toCents(s.minimum.value)?.cents !== undefined && <p className="small muted">The {s.appScreen ? 'last statement’s' : 'statement’s'} minimum payment is {cash(toCents(s.minimum.value)!.cents)}.</p>}
          {buys.length > 0 && (
            <div className="stack gap-8">
              <b className="small">New interest-free purchases</b>
              {buys.map((row) => (
                <label key={row.index} className="check-row small">
                  <input type="checkbox" checked={row.add} disabled={!!row.existing}
                    onChange={(e) => edit((d) => { d.statement.purchases[row.index].add = e.target.checked; })} />
                  <span>{row.description || 'Purchase'} {cash(row.cents)} on {fmtShort(row.date)}: {row.existing
                    ? `already your plan “${row.existing.name}”`
                    : `add as a plan, interest-free until ${fmtShort(addMonths(row.date, row.months!))}`}</span>
                </label>
              ))}
            </div>
          )}
          {debt && s.plans.length > 0 && (
            <div className="stack gap-8">
              <b className="small">Plans on the statement</b>
              {s.plans.map((row, i) => { const match = resolvePlanRow(row, debt); return (
                <div key={row.newId} className="inset stack gap-8" style={{ padding: 'var(--s-3)' }}>
                  <span className="small">{row.description || 'Plan'}{row.ends ? `, interest-free until ${fmtShort(row.ends)}` : ''}</span>
                  <div className="form-grid">
                    <Money label="Left on it" fig={row.remaining} onChange={(v) => edit((d) => { d.statement.plans[i].remaining.value = v; })} />
                    <label className="field">It’s your
                      <select value={row.planId && debt.plans.some((p) => p.id === row.planId) ? row.planId : row.planId === NOT_MINE ? NOT_MINE : ''} onChange={(e) => edit((d) => { d.statement.plans[i].planId = e.target.value; if (e.target.value && e.target.value !== NOT_MINE) d.statement.plans[i].ends = ''; })}>
                        <option value="">Match by expiry date</option>
                        {debt.plans.map((p) => <option key={p.id} value={p.id}>{p.name} ({cash(p.remaining)}, until {fmtShort(planEnds(p))})</option>)}
                        <option value={NOT_MINE}>Not one of mine</option>
                      </select>
                    </label>
                  </div>
                  {match ? (
                    <span className="xs muted">Matched to your plan “{match.name}”.</span>
                  ) : (
                    <label className="check-row small">
                      <input type="checkbox" checked={row.addAsNew} onChange={(e) => edit((d) => { d.statement.plans[i].addAsNew = e.target.checked; })} />
                      It isn’t one of my plans: add it as a new plan
                    </label>
                  )}
                </div>
              ); })}
            </div>
          )}
        </>
      )}

      {draft.kind === 'kiwisaver' && <KiwiSaverCheck draft={draft} edit={edit} />}
      {draft.kind === 'balances' && <BalancesCheck draft={draft} edit={edit} />}

      {draft.kind === 'afterpay' && ap && (
        <>
          <label className="check-row" style={{ alignItems: 'flex-start' }}>
            <input type="checkbox" checked={draft.afterpay.listsAllDue} onChange={(e) => edit((d) => { d.afterpay.listsAllDue = e.target.checked; })} style={{ width: 20, height: 20, flex: 'none', marginTop: 2, accentColor: 'var(--brand)' }} />
            <span>
              Upcoming payments — everything still due
              <span className="small muted block">Tick for Afterpay’s Upcoming payments screen: orders not listed are marked paid off. Leave off for a single order.</span>
            </span>
          </label>
          {draft.afterpay.orders.map((o, i) => (
            <div key={o.newId} className="inset stack gap-8" style={{ padding: 'var(--s-3)' }}>
              <span className="small"><b>{o.merchant || 'Order'}</b>{o.purchaseDate ? `, bought ${fmtShort(o.purchaseDate)}` : ''}{toCents(o.total.value) ? `, ${cash(toCents(o.total.value)!.cents)} total` : ''}</span>
              <span className="xs muted">{o.instalments.map((x) => `${x.label ?? ''} ${toCents(x.amount) ? cash(toCents(x.amount)!.cents) : x.amount} on ${x.date ? fmtShort(x.date) : '?'}${x.paid ? ' (paid)' : ''}`.trim()).join(' · ') || 'No instalments read'}</span>
              <label className="field">It’s
                <select value={o.planId && ap.plans.some((p) => p.id === o.planId) ? o.planId : o.planId === NOT_MINE ? NOT_MINE : ''} onChange={(e) => edit((d) => { d.afterpay.orders[i].planId = e.target.value; })}>
                  <option value="">Match automatically</option>
                  {ap.plans.map((p) => <option key={p.id} value={p.id}>{p.name} ({cash(p.remaining)} left)</option>)}
                  <option value={NOT_MINE}>A new order</option>
                </select>
              </label>
            </div>
          ))}
        </>
      )}

      {blocks.length > 0 && (
        <div className="alert small" role="alert"><Icon name="alert" /><div>{blocks.map((b) => <div key={b.text}>{b.text}</div>)}</div></div>
      )}
      {notes.length > 0 && (
        <div className="tip small"><Icon name="info" /><div className="stack gap-2">{notes.map((n) => <div key={n.text}>{n.text}</div>)}</div></div>
      )}

      {pv && (
        <div className="stack gap-8">
          <b className="small">What will change</b>
          <ul className="notes-list">{pv.lines.map((l) => <li key={l}>{l}</li>)}</ul>
          {pv.explain.map((t) => <p key={t} className="small muted">{t}</p>)}
          <p className="small muted">
            {pv.payChangeCount === 0 ? 'Your next 12 pays’ payday amounts stay the same.' : `Your next 12 pays rebalance: ${pv.payChangeCount} payday amount${pv.payChangeCount === 1 ? '' : 's'} change.`}
          </p>
          {pv.payChanges.length > 0 && (
            <ul className="notes-list small">
              {pv.payChanges.map((c) => <li key={c.account}>{c.account}: {c.pays} pay{c.pays === 1 ? '' : 's'}, from {fmtShort(c.first.date)} {cash(c.first.from)} → {cash(c.first.to)}</li>)}
            </ul>
          )}
        </div>
      )}

      {r.ignored.length > 0 && (
        <details className="small">
          <summary>Not changed ({r.ignored.length})</summary>
          <ul className="notes-list">{r.ignored.map((t) => <li key={t}>{t}</li>)}</ul>
        </details>
      )}

      {stale && <p className="small" role="status">Your budget changed while this was open (it synced), so the rundown above has been worked out again. Check it, then confirm.</p>}
      <div className="row end">
        <button className="btn" onClick={onCancel}>{cancelLabel}</button>
        <button className="btn primary" disabled={!r.proposal || blocks.length > 0} onClick={() => {
          if (!r.proposal || !pv) return;
          if (stale) { setSeen(print); return; } // show what changed first
          onConfirm(r.proposal, pv);
        }}>Confirm</button>
      </div>
    </>
  );
}

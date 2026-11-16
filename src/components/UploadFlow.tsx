import { useEffect, useMemo, useRef, useState } from 'react';
import { fmtShort, todayISO, type ISODate } from '../lib/dates';
import { owed, planEnds } from '../lib/debts';
import { cash } from '../lib/money';
import { applyProposal, fingerprint, preview } from '../lib/reader/apply';
import { NEW_DEBT, NOT_MINE, resolvePlanRow, review, toCents, toDraft, type Draft, type DraftFig } from '../lib/reader/check';
import { DEVICE_FALLBACK, errorMessage, ReaderError } from '../lib/reader/errors';
import { startRead, type ReadJob } from '../lib/reader/job';
import type { DocKind, Extraction } from '../lib/reader/types';
import { buildUndo, undoKeeps, undoUpload, writeUndo, type UndoRecord } from '../lib/reader/undo';
import { newId, useBudget } from '../lib/store';
import { Icon } from './Icon';

// ---------------------------------------------------------------------------------------------
// The one upload flow, used by the Add button and the Planner: reading → a rundown of every change
// (which you can correct) → Confirm → done, with Undo. Nothing in the budget changes before Confirm.
// ---------------------------------------------------------------------------------------------

type Phase =
  | { s: 'reading' }
  | { s: 'error'; err: ReaderError }
  | { s: 'review'; draft: Draft }
  | { s: 'done'; kind: DocKind; lines: string[]; explain: string[]; rec: UndoRecord }
  | { s: 'undone'; kept: string[] };

const KIND_TITLE: Record<DocKind, string> = { payslip: 'Check this payslip', statement: 'Check this statement', afterpay: 'Check these Afterpay orders', unknown: 'Check this document' };
const RETRY = new Set(['too_fast', 'overloaded', 'offline', 'unreachable', 'timeout', 'unusable']);

/** A blank form, for typing the figures in. */
const blank = (kind: DocKind): Extraction => ({ kind });

export function UploadFlow({ job: firstJob, onClose, onPayslip }: { job: ReadJob; onClose: () => void; onPayslip?: (start: ISODate) => void }) {
  const { budget, update } = useBudget();
  const [job, setJob] = useState(firstJob);
  const [phase, setPhase] = useState<Phase>({ s: 'reading' });
  const [progress, setProgress] = useState(0);
  const budgetRef = useRef(budget);
  budgetRef.current = budget;
  const file = job.file;

  // Wait for the read that was started when the file was chosen (so it's only ever sent once).
  useEffect(() => {
    let live = true;
    setPhase({ s: 'reading' });
    setProgress(0);
    const off = job.onProgress((p) => { if (live) setProgress(p); });
    job.promise.then(
      (ex) => { if (live) setPhase({ s: 'review', draft: toDraft(ex, budgetRef.current, job.source, newId) }); },
      (e) => {
        if (!live) return;
        const err = e instanceof ReaderError ? e : new ReaderError(job.source === 'device' ? 'bad_file' : 'unusable', { detail: job.source === 'device' ? 'That file couldn’t be read on this device. Type the figures in instead.' : undefined });
        if (err.kind === 'cancelled') onClose(); else setPhase({ s: 'error', err });
      },
    );
    return () => { live = false; off(); };
    // A new job (read on this device, try again) restarts this; nothing else does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job]);

  const close = () => { if (phase.s === 'reading') job.cancel(); onClose(); };
  const title = phase.s === 'reading' ? 'Reading…' : phase.s === 'error' ? 'Couldn’t read it' : phase.s === 'review' ? KIND_TITLE[phase.draft.kind] : phase.s === 'done' ? 'Saved' : 'Undone';

  return (
    <div className="modal-back" onClick={close}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="up-title" onClick={(e) => e.stopPropagation()}>
        <div className="between nowrap">
          <div className="min0">
            <h2 id="up-title" className="h2">{title}</h2>
            <span className="small muted" style={{ overflowWrap: 'anywhere' }}>{file.name}</span>
          </div>
          <button className="icon-btn plain" aria-label="Close" onClick={close}><Icon name="x" /></button>
        </div>

        {phase.s === 'reading' && (
          <div role="status" className="stack gap-8">
            <p className="small muted">{job.source === 'device'
              ? (file.type.startsWith('image/') ? 'Reading the text in the photo on this device. This can take a little while the first time.' : 'Reading the PDF on this device.')
              : 'Sent to Google’s Gemini to read. This usually takes a few seconds.'}</p>
            <div className="bar"><div style={{ width: job.source === 'device' ? `${Math.max(6, Math.round(progress * 100))}%` : '40%' }} /></div>
            <div className="row end"><button className="btn" onClick={close}>Cancel</button></div>
          </div>
        )}

        {phase.s === 'error' && (
          <ErrorView err={phase.err} source={job.source} onClose={onClose}
            onDevice={() => setJob(startRead(file, budget, 'device'))}
            onRetry={() => setJob(startRead(file, budget, 'gemini'))}
            onType={() => setPhase({ s: 'review', draft: toDraft(blank(/\.pdf$/i.test(file.name) || file.type === 'application/pdf' ? 'payslip' : 'statement'), budget, 'device', newId) })} />
        )}

        {phase.s === 'review' && (
          <Rundown draft={phase.draft} sourceLabel={job.source === 'device' ? 'Read on this device' : 'Read by Google’s Gemini'}
            onEdit={(draft) => setPhase({ s: 'review', draft })}
            onCancel={onClose}
            onConfirm={(proposal, pv) => {
              const today = todayISO();
              const rec = buildUndo(budget, pv.after, proposal, file.name, KIND_TITLE[phase.draft.kind].replace('Check ', ''));
              writeUndo(rec);
              update((b) => applyProposal(b, proposal, today));
              setPhase({ s: 'done', kind: proposal.kind, lines: pv.lines, explain: pv.explain, rec });
              if (proposal.kind === 'payslip' && pv.payStart) onPayslip?.(pv.payStart);
            }} />
        )}

        {phase.s === 'done' && (
          <>
            <div role="status" className="stack gap-8">
              <ul className="notes-list">{phase.lines.map((l) => <li key={l}>{l}</li>)}</ul>
              {phase.explain.map((t) => <p key={t} className="small muted">{t}</p>)}
            </div>
            <div className="row end wrap">
              <button className="btn" onClick={() => {
                const today = todayISO();
                const kept = undoKeeps(budget, phase.rec, today);
                update((b) => { undoUpload(b, phase.rec, today); return b; });
                writeUndo(null);
                setPhase({ s: 'undone', kept });
              }}>Undo</button>
              <a className="btn" href={phase.kind === 'payslip' ? '#/planner' : '#/debts'} onClick={onClose}>{phase.kind === 'payslip' ? 'Open Planner' : 'Open Debts'}</a>
              <button className="btn primary" onClick={onClose}>Done</button>
            </div>
          </>
        )}

        {phase.s === 'undone' && (
          <>
            <p role="status">That upload is undone: everything it changed is back as it was{phase.kept.length ? ', except:' : '.'}</p>
            {phase.kept.length > 0 && <ul className="notes-list">{phase.kept.map((k) => <li key={k}>{k}</li>)}</ul>}
            <div className="row end"><button className="btn primary" onClick={onClose}>Done</button></div>
          </>
        )}
      </div>
    </div>
  );
}

function ErrorView({ err, source, onClose, onDevice, onRetry, onType }: { err: ReaderError; source: 'gemini' | 'device'; onClose: () => void; onDevice: () => void; onRetry: () => void; onType: () => void }) {
  const m = errorMessage(err);
  return (
    <>
      <div className="alert" role="alert">
        <Icon name="alert" />
        <div><b>{m.title}</b> {m.body} Nothing in your budget was changed.</div>
      </div>
      {err.detail && err.kind !== 'bad_file' && <p className="xs muted" style={{ overflowWrap: 'anywhere' }}>Google said: {err.detail}</p>}
      <div className="row end wrap">
        <button className="btn" onClick={onClose}>Close</button>
        {(err.kind === 'no_key' || err.kind === 'bad_key' || err.kind === 'model_gone' || err.kind === 'billing_needed') && <a className="btn" href="#/settings" onClick={onClose}>Open Settings</a>}
        <button className="btn" onClick={onType}>Type it in</button>
        {source === 'gemini' && DEVICE_FALLBACK.has(err.kind) && <button className="btn" onClick={onDevice}>Read it on this device instead</button>}
        {source === 'gemini' && RETRY.has(err.kind) && <button className="btn primary" onClick={onRetry}>Try again</button>}
      </div>
    </>
  );
}

/** An amount box: what was read, with the document's own label for it. */
function Money({ label, fig, onChange, placeholder }: { label: string; fig: DraftFig; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className="field">{label}
      <input inputMode="decimal" value={fig.value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      {fig.label && <span className="xs muted">On the document: “{fig.label}”</span>}
    </label>
  );
}

function Rundown({ draft, sourceLabel, onEdit, onCancel, onConfirm }: {
  draft: Draft;
  sourceLabel: string;
  onEdit: (d: Draft) => void;
  onCancel: () => void;
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
  const debts = (budget.debts ?? []).filter((d) => !d.payroll);
  const s = draft.statement;
  const debt = debts.find((d) => d.id === s.debtId);
  const ap = (budget.debts ?? []).find((d) => d.id === draft.afterpay.debtId);

  return (
    <>
      <span className="pill" style={{ alignSelf: 'flex-start' }}>{sourceLabel}</span>
      <div className="seg" role="group" aria-label="What this is" style={{ alignSelf: 'flex-start' }}>
        {(['payslip', 'statement', 'afterpay'] as const).map((k) => (
          <button key={k} aria-pressed={draft.kind === k} onClick={() => edit((d) => { d.kind = k; })}>{k === 'payslip' ? 'Payslip' : k === 'statement' ? 'Card or loan statement' : 'Afterpay'}</button>
        ))}
      </div>

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
            <label className="field">As at (statement date)
              <input type="date" value={s.date} max={today} onChange={(e) => edit((d) => { d.statement.date = e.target.value; })} />
            </label>
            <Money label="Credit limit (optional)" fig={s.limit} onChange={(v) => edit((d) => { d.statement.limit.value = v; })} />
          </div>
          {toCents(s.minimum.value)?.cents !== undefined && <p className="small muted">The statement’s minimum payment is {cash(toCents(s.minimum.value)!.cents)}.</p>}
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

      {draft.kind === 'afterpay' && ap && draft.afterpay.orders.map((o, i) => (
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
        <button className="btn" onClick={onCancel}>Cancel</button>
        <button className="btn primary" disabled={!r.proposal || blocks.length > 0} onClick={() => {
          if (!r.proposal || !pv) return;
          if (stale) { setSeen(print); return; } // show what changed first
          onConfirm(r.proposal, pv);
        }}>Confirm</button>
      </div>
    </>
  );
}

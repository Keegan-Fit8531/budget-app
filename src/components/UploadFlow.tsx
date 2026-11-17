import { useEffect, useMemo, useRef, useState } from 'react';
import { addMonths, fmtShort, fmtSpan, todayISO, type ISODate } from '../lib/dates';
import { owed, planEnds } from '../lib/debts';
import { cash, centsToInput } from '../lib/money';
import { applyProposal, fingerprint, preview } from '../lib/reader/apply';
import { csvBalance, csvTargets, NEW_DEBT, NEW_GOAL, NOT_MINE, purchaseRows, resolvePlanRow, review, toCents, toDraft, type Draft, type DraftFig } from '../lib/reader/check';
import { CATEGORY_LABEL, shopMap, summarize } from '../lib/spending';
import { DEVICE_FALLBACK, errorMessage, ReaderError } from '../lib/reader/errors';
import { isKiwiSaver } from '../lib/kiwisaver';
import { isCsv, startRead, type ReadJob, type ReadStage } from '../lib/reader/job';
import type { DocKind, Extraction } from '../lib/reader/types';
import { newId, useBudget } from '../lib/store';
import { isStaleBuild } from './ErrorBoundary';
import { Icon } from './Icon';
import { showToast } from './toast';

// ---------------------------------------------------------------------------------------------
// The one upload flow, used by the Add button and the Planner: reading → a rundown of every change
// (which you can correct) → Confirm, which saves and closes. Nothing in the budget changes before
// Confirm; a change can be put right from Settings → Saved copies.
// ---------------------------------------------------------------------------------------------

type Phase =
  | { s: 'reading' }
  | { s: 'error'; err: ReaderError }
  | { s: 'review'; draft: Draft };

const KIND_TITLE: Record<DocKind, string> = { payslip: 'Check this payslip', statement: 'Check this statement', afterpay: 'Check these Afterpay orders', kiwisaver: 'Check this KiwiSaver statement', transactions: 'Check these transactions', unknown: 'Check this document' };
const RETRY = new Set(['too_fast', 'overloaded', 'offline', 'unreachable', 'timeout', 'unusable']);
const titleOf = (d: Draft) => (d.kind === 'statement' && d.statement.appScreen ? 'Check this card screenshot' : KIND_TITLE[d.kind]);

/** How far along a Gemini read looks: getting the file ready, then Google reading it (a few seconds, plus the upload). */
function readingProgress(stage: ReadStage, now: number): { pct: number; slow: boolean } {
  if (stage.step === 'preparing') return { pct: 6, slow: false };
  const t = Math.max(0, now - stage.since);
  if (stage.parts) {
    // A long PDF in parts: a step for each part read, and a little more while the next is on its way.
    const done = stage.done ?? 0;
    const step = 80 / stage.parts;
    const moving = done < stage.parts ? step * 0.8 * (1 - Math.exp(-t / 8000)) : 0;
    return { pct: 15 + step * done + moving, slow: t > Math.ceil(stage.parts / 8) * 30_000 };
  }
  const expected = 2500 + stage.bytes / 1000; // about 2.5 s to read, and sending at about 1 MB a second
  return { pct: 15 + 80 * (1 - Math.exp(-t / expected)), slow: t > expected * 3 };
}

/** A blank form, for typing the figures in. */
const blank = (kind: DocKind): Extraction => ({ kind });

/** Several documents chosen at once: all read straight away, then checked one at a time (each for its own account or debt). */
export function UploadQueue({ jobs, onClose, onPayslip }: { jobs: ReadJob[]; onClose: () => void; onPayslip?: (start: ISODate) => void }) {
  const [i, setI] = useState(0);
  if (jobs.length === 1) return <UploadFlow job={jobs[0]} onClose={onClose} onPayslip={onPayslip} />;
  const stopAll = () => { jobs.slice(i).forEach((j) => j.cancel()); onClose(); };
  return (
    <UploadFlow key={`${i}-${jobs[i].file.name}`} job={jobs[i]} onClose={stopAll} onPayslip={onPayslip}
      queue={{ index: i, total: jobs.length, onNext: () => (i + 1 < jobs.length ? setI(i + 1) : onClose()) }} />
  );
}

export function UploadFlow({ job: firstJob, onClose, onPayslip, queue }: {
  job: ReadJob;
  /** Close (with several documents, the rest too). */
  onClose: () => void;
  onPayslip?: (start: ISODate) => void;
  /** One of several documents: Confirm and Skip go on to the next. */
  queue?: { index: number; total: number; onNext: () => void };
}) {
  const { budget, update } = useBudget();
  const next = queue?.onNext ?? onClose;
  const [job, setJob] = useState(firstJob);
  const [phase, setPhase] = useState<Phase>({ s: 'reading' });
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState<ReadStage>({ step: 'preparing' });
  const [now, setNow] = useState(() => Date.now());
  const budgetRef = useRef(budget);
  budgetRef.current = budget;
  const file = job.file;

  // Wait for the read that was started when the file was chosen (so it's only ever sent once).
  useEffect(() => {
    let live = true;
    setPhase({ s: 'reading' });
    setProgress(0);
    const off = job.onProgress((p) => { if (live) setProgress(p); });
    const offStage = job.onStage((st) => { if (live) setStage(st); });
    job.promise.then(
      (ex) => { if (live) setPhase({ s: 'review', draft: toDraft(ex, budgetRef.current, job.source, newId) }); },
      (e) => {
        if (!live) return;
        // A part of the reader that this older copy of the app can't load any more (a new version is up).
        const err = e instanceof ReaderError ? e : isStaleBuild(e) ? new ReaderError('app_updated') : new ReaderError(job.source === 'device' ? 'bad_file' : 'unusable', { detail: job.source === 'device' ? 'That file couldn’t be read on this device. Type the figures in instead.' : undefined });
        if (err.kind === 'cancelled') { if (!queue) onClose(); } else setPhase({ s: 'error', err });
      },
    );
    return () => { live = false; off(); offStage(); };
    // A new job (read on this device, try again) restarts this; nothing else does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job]);

  // While Google reads it, move the bar along with the time it usually takes.
  const reading = phase.s === 'reading' && job.source === 'gemini';
  useEffect(() => {
    if (!reading) return;
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, [reading]);

  const close = () => { if (phase.s === 'reading') job.cancel(); onClose(); };
  const title = phase.s === 'reading' ? 'Reading…' : phase.s === 'error' ? 'Couldn’t read it' : titleOf(phase.draft);
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  const gp = readingProgress(stage, now);
  const secs = stage.step === 'reading' ? Math.floor((now - stage.since) / 1000) : 0;

  return (
    <div className="modal-back" onClick={close}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="up-title" onClick={(e) => e.stopPropagation()}>
        <div className="between nowrap">
          <div className="min0">
            <h2 id="up-title" className="h2">{title}</h2>
            <span className="small muted" style={{ overflowWrap: 'anywhere' }}>{queue ? `${queue.index + 1} of ${queue.total}: ` : ''}{file.name}</span>
          </div>
          <button className="icon-btn plain" aria-label="Close" onClick={close}><Icon name="x" /></button>
        </div>

        {phase.s === 'reading' && (
          <div className="stack gap-8">
            <p className="small muted" role="status">{job.source === 'device'
              ? (file.type.startsWith('image/') ? 'Reading the text in the photo on this device. This can take a little while the first time.' : isCsv(file) ? 'Reading the export on this device…' : 'Reading the PDF on this device.')
              : stage.step === 'preparing'
                ? (isPdf ? 'Getting the PDF ready to send…' : 'Making the image smaller to send…')
                : stage.parts
                  ? `Google’s Gemini is reading the ${stage.pages} pages, a few at a time: ${stage.read ?? 0} of ${stage.pages} read…`
                  : `Google’s Gemini is reading it (${stage.bytes < 1e6 ? `${Math.max(1, Math.round(stage.bytes / 1000))} KB` : `${(stage.bytes / 1e6).toFixed(1)} MB`} sent)…`}</p>
            <div className="bar moving" role="progressbar" aria-label="Reading" aria-valuemin={0} aria-valuemax={100}
              aria-valuenow={Math.round(job.source === 'device' ? progress * 100 : gp.pct)}>
              <div style={{ width: `${job.source === 'device' ? Math.max(6, Math.round(progress * 100)) : gp.pct.toFixed(1)}%` }} />
            </div>
            {job.source === 'gemini' && stage.step === 'reading' && (
              <span className="xs muted">{gp.slow ? `${secs} s: taking longer than usual. You can keep waiting, or cancel and try again.` : secs >= 1 ? `${secs} s` : '\u00a0'}</span>
            )}
            <div className="row end">
              {queue ? <button className="btn" onClick={() => { job.cancel(); next(); }}>Skip this one</button> : <button className="btn" onClick={close}>Cancel</button>}
            </div>
          </div>
        )}

        {phase.s === 'error' && (
          <ErrorView err={phase.err} source={job.source} onClose={next} closeLabel={queue ? 'Skip this one' : 'Close'}
            onDevice={() => setJob(startRead(file, budget, 'device'))}
            onRetry={() => setJob(startRead(file, budget, 'gemini'))}
            onType={() => setPhase({ s: 'review', draft: toDraft(blank(/\.pdf$/i.test(file.name) || file.type === 'application/pdf' ? 'payslip' : 'statement'), budget, 'device', newId) })} />
        )}

        {phase.s === 'review' && (
          <Rundown draft={phase.draft} sourceLabel={job.source === 'device' ? 'Read on this device' : 'Read by Google’s Gemini'}
            onEdit={(draft) => setPhase({ s: 'review', draft })}
            onCancel={next} cancelLabel={queue ? 'Skip this one' : 'Cancel'}
            onConfirm={(proposal, pv) => {
              update((b) => applyProposal(b, proposal, todayISO()));
              if (proposal.kind === 'payslip' && pv.payStart) onPayslip?.(pv.payStart);
              const more = pv.lines.length - 1;
              showToast(`Saved${queue ? ` ${queue.index + 1} of ${queue.total}` : ''}. ${pv.lines[0] ?? ''}${more > 0 ? ` (and ${more} more change${more === 1 ? '' : 's'})` : ''}`);
              next();
            }} />
        )}

      </div>
    </div>
  );
}

function ErrorView({ err, source, onClose, closeLabel, onDevice, onRetry, onType }: { err: ReaderError; source: 'gemini' | 'device'; onClose: () => void; closeLabel: string; onDevice: () => void; onRetry: () => void; onType: () => void }) {
  const m = errorMessage(err);
  return (
    <>
      <div className="alert" role="alert">
        <Icon name="alert" />
        <div><b>{m.title}</b> {m.body} Nothing in your budget was changed.</div>
      </div>
      {err.detail && err.kind !== 'bad_file' && <p className="xs muted" style={{ overflowWrap: 'anywhere' }}>Google said: {err.detail}</p>}
      <div className="row end wrap">
        <button className="btn" onClick={onClose}>{closeLabel}</button>
        {(err.kind === 'no_key' || err.kind === 'bad_key' || err.kind === 'model_gone' || err.kind === 'billing_needed') && <a className="btn" href="#/settings" onClick={onClose}>Open Settings</a>}
        {err.kind === 'app_updated' ? <button className="btn primary" onClick={() => window.location.reload()}>Reload the app</button> : <button className="btn" onClick={onType}>Type it in</button>}
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

function Rundown({ draft, sourceLabel, onEdit, onCancel, cancelLabel, onConfirm }: {
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
  const debts = (budget.debts ?? []).filter((d) => !d.payroll);
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
          {(['payslip', 'statement', 'kiwisaver', 'afterpay'] as const).map((k) => (
            <button key={k} aria-pressed={draft.kind === k} onClick={() => edit((d) => { d.kind = k; })}>{k === 'payslip' ? 'Payslip' : k === 'statement' ? 'Card or loan' : k === 'kiwisaver' ? 'KiwiSaver' : 'Afterpay'}</button>
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
            <Money label="Credit limit (optional)" fig={s.limit} onChange={(v) => edit((d) => { d.statement.limit.value = v; })} />
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

/** A KiwiSaver statement or screen: which goal, the balance and its date, each fund, and what went in and was earned. */
function KiwiSaverCheck({ draft, edit }: { draft: Draft; edit: (fn: (d: Draft) => void) => void }) {
  const { budget } = useBudget();
  const k = draft.kiwisaver;
  const goals = (budget.savings ?? []).filter(isKiwiSaver);
  const others = (budget.savings ?? []).filter((g) => !isKiwiSaver(g));
  const set = (key: 'balance' | 'opening' | 'employee' | 'employer' | 'government' | 'voluntary' | 'withdrawals' | 'earnings' | 'tax' | 'returns') => (v: string) => edit((d) => { d.kiwisaver[key].value = v; });
  return (
    <>
      <label className="field">Which KiwiSaver it’s for
        <select value={k.goalId} onChange={(e) => edit((d) => { d.kiwisaver.goalId = e.target.value; })}>
          {goals.map((g) => <option key={g.id} value={g.id}>{g.name} (now {cash(g.balance)})</option>)}
          {others.length > 0 && <optgroup label="Other savings goals">{others.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</optgroup>}
          <option value={NEW_GOAL}>+ A new KiwiSaver goal</option>
        </select>
        {k.provider && <span className="xs muted">On the document: “{k.provider}”</span>}
      </label>
      <div className="form-grid">
        <Money label="Balance (closing value)" fig={k.balance} placeholder="31,614.19" onChange={set('balance')} />
        <label className="field">As at
          <input type="date" value={k.date} onChange={(e) => edit((d) => { d.kiwisaver.date = e.target.value; })} />
        </label>
      </div>
      <div className="stack gap-8">
        <b className="small">Funds</b>
        {k.funds.map((f, i) => (
          <div key={i} className="row nowrap gap-8">
            <input aria-label="Fund" value={f.name} placeholder="High Growth" onChange={(e) => edit((d) => { d.kiwisaver.funds[i].name = e.target.value; })} />
            <input aria-label={`${f.name || 'Fund'} value`} inputMode="decimal" value={f.value} placeholder="0.00" onChange={(e) => edit((d) => { d.kiwisaver.funds[i].value = e.target.value; })} />
            <button className="icon-btn plain" aria-label={`Remove ${f.name || 'fund'}`} onClick={() => edit((d) => { d.kiwisaver.funds.splice(i, 1); })}><Icon name="x" size={16} /></button>
          </div>
        ))}
        <button className="btn small" style={{ alignSelf: 'flex-start' }} onClick={() => edit((d) => { d.kiwisaver.funds.push({ name: '', value: '' }); })}><Icon name="plus" size={16} /> Add a fund</button>
      </div>
      <details className="small" open={!!(k.since || k.opening.value || k.earnings.value || k.returns.value)}>
        <summary>Contributions and returns</summary>
        <div className="form-grid" style={{ marginTop: 'var(--s-2)' }}>
          <label className="field">From
            <input type="date" value={k.since} onChange={(e) => edit((d) => { d.kiwisaver.since = e.target.value; })} />
            <span className="xs muted">The opening value’s date.</span>
          </label>
          <Money label="Opening value" fig={k.opening} onChange={set('opening')} />
          <Money label="Your contributions" fig={k.employee} onChange={set('employee')} />
          <Money label="Employer contributions" fig={k.employer} onChange={set('employer')} />
          <Money label="Government contribution" fig={k.government} onChange={set('government')} />
          <Money label="Voluntary contributions" fig={k.voluntary} onChange={set('voluntary')} />
          <Money label="Withdrawals" fig={k.withdrawals} onChange={set('withdrawals')} />
          <Money label="Investment earnings (before tax)" fig={k.earnings} placeholder="A loss: -500.00" onChange={set('earnings')} />
          <Money label="PIE tax" fig={k.tax} onChange={set('tax')} />
          <Money label="Returns (if that’s all it shows)" fig={k.returns} onChange={set('returns')} />
        </div>
      </details>
    </>
  );
}

/**
 * A bank or card export: a file doesn't say whose it is, so you're asked which card or account (or
 * shown the one with that number from last time, to check), and what's owed or in it now.
 */
function TransactionsCheck({ draft, edit }: { draft: Draft; edit: (fn: (d: Draft) => void) => void }) {
  const { budget } = useBudget();
  const t = draft.transactions;
  const rows = t.read.rows;
  const targets = csvTargets(budget);
  const isDebt = t.target.startsWith('debt:');
  const suggested = csvBalance(draft, budget);
  const out = rows.filter((x) => x.amount < 0).reduce((a, x) => a - x.amount, 0);
  const inn = rows.filter((x) => x.amount > 0).reduce((a, x) => a + x.amount, 0);
  const matched = t.matchedBy ? targets.find((x) => x.value === t.target) : undefined;
  const shown = t.amount ?? (suggested ? centsToInput(isDebt ? Math.max(0, suggested.amount) : suggested.amount) : '');
  const top = rows.length ? summarize(rows, rows[0].date, rows[rows.length - 1].date, shopMap(budget)).categories.filter((c) => c.category !== 'other').slice(0, 3) : [];
  return (
    <>
      {rows.length > 0 && (
        <p className="small">{rows.length} transaction{rows.length === 1 ? '' : 's'}, {fmtSpan(rows[0].date, rows[rows.length - 1].date)}: {cash(out)} {t.read.card ? 'spent' : 'out'}, {cash(inn)} {t.read.card ? 'paid' : 'in'}.
          {top.length > 0 && <span className="muted"> Most went on {top.map((c) => `${CATEGORY_LABEL[c.category].toLowerCase()} (${cash(c.total, { whole: true })})`).join(', ')}.</span>}
        </p>
      )}
      <label className="field">Which {t.read.card ? 'card' : 'card or account'} is this for?
        <select value={t.target} onChange={(e) => edit((d) => { d.transactions.target = e.target.value; d.transactions.matchedBy = undefined; d.transactions.amount = null; })}>
          {!t.target && <option value="">Choose…</option>}
          {(t.read.card ? (['Cards and loans', 'Accounts'] as const) : (['Accounts', 'Cards and loans'] as const)).filter((g) => targets.some((x) => x.group === g)).map((g) => (
            <optgroup key={g} label={g}>{targets.filter((x) => x.group === g).map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</optgroup>
          ))}
        </select>
        <span className="xs muted">{matched
          ? `Chosen because ${matched.label} has number ending ${t.matchedBy}. Change it if that’s wrong.`
          : `The file doesn’t say whose it is${t.read.ending ? `. Once you confirm, number ending ${t.read.ending} goes straight to it next time` : ''}.`}</span>
      </label>
      {t.target && (
        <label className="field">{isDebt ? 'Owed now' : 'Balance now'}
          <input inputMode="decimal" value={shown} placeholder={isDebt ? 'What your app says you owe' : 'What your banking app says'}
            onChange={(e) => edit((d) => { d.transactions.amount = e.target.value; })} />
          <span className="xs muted">{t.amount === null && suggested
            ? `${suggested.working} That’s as at ${fmtShort(suggested.asOf)}: check it against your app.`
            : t.amount !== null && t.amount.trim() ? 'As at today, as you typed it.' : 'Leave it empty to keep what’s saved.'}</span>
        </label>
      )}
    </>
  );
}

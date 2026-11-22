import { useEffect, useRef, useState } from 'react';
import { todayISO, type ISODate } from '../../../core/dates';
import { applyProposal } from '../apply';
import { type Draft } from '../check/draft';
import { toDraft } from '../check/toDraft';
import { DEVICE_FALLBACK, errorMessage, ReaderError } from '../errors';
import { isCsv, startRead, type ReadJob, type ReadStage } from '../job';
import type { DocKind, Extraction } from '../types';
import { newId, useBudget } from '../../../state/store';
import { isStaleBuild } from '../../../ui/ErrorBoundary';
import { Icon } from '../../../ui/Icon';
import { showToast } from '../../../ui/toast';
import { Rundown } from './Rundown';

// ---------------------------------------------------------------------------------------------
// The one upload flow, used by the Add button and the Planner: reading → a rundown of every change
// (which you can correct) → Confirm, which saves and closes. Nothing in the budget changes before
// Confirm; a change can be put right from Settings → Saved copies.
// ---------------------------------------------------------------------------------------------

type Phase =
  | { s: 'reading' }
  | { s: 'error'; err: ReaderError }
  | { s: 'review'; draft: Draft };

const KIND_TITLE: Record<DocKind, string> = { payslip: 'Check this payslip', statement: 'Check this statement', afterpay: 'Check these Afterpay orders', kiwisaver: 'Check this KiwiSaver statement', transactions: 'Check these transactions', balances: 'Check these balances', unknown: 'Check this document' };
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

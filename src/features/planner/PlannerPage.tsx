import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { startRead, type ReadJob } from '../../services/reader/job';
import { applyBalance } from '../../engine/rebalance';
import { freezePaySplit, unfreezePaySplit } from '../../engine/balances/freeze';
import { Donut, Legend } from '../../ui/Donut';
import { Icon } from '../../ui/Icon';
import { ErrorBoundary } from '../../ui/ErrorBoundary';
import { AccountEditModal, type AccountTab } from '../accounts/AccountEdit';
import { WeeksView } from './WeeksView';
import { PaydayCard, type PlannerView } from './PaydayCard';
import { PayNotes, type AdjEdit } from './PayNotes';
import { DueList } from './DueList';
import { PayNav, useViewPeriod, ViewModes } from '../../state/period';
import { clearOptimiseUndo, OptimiseModal, readOptimiseUndo, type OptimiseUndo } from './OptimiseModal';
import { undoAllocation } from './logic/allocate';
import { resetPay, setThisPay as setPayAmount } from './logic/thisPay';
import { modesChangedIn, rememberModes, takeModes } from './logic/modeMemory';
import { plannerFigures, type LastBalance } from './logic/plannerFigures';
import { todayISO } from '../../core/dates';
import { shiftPeriod, upcomingPayPeriod } from '../../engine/periods';
import { cash, moneyParts, centsToInput, parseMoney } from '../../core/money';
import { useBudget } from '../../state/store';
import type { Cents } from '../../core/types';

// Loaded only when a document is chosen.
const UploadQueue = lazy(() => import('../../services/reader/ui/UploadFlow').then((m) => ({ default: m.UploadQueue })));

export function PlannerPage() {
  const { budget, update } = useBudget();
  const today = todayISO();
  const { offset, setOffset, period, mode } = useViewPeriod();
  const [showAllDues, setShowAllDues] = useState(false);
  // The account card whose details pop-up is open.
  const [openCard, setOpenCard] = useState<string | null>(null);
  const [payEdit, setPayEdit] = useState<string | null>(null);
  // A payslip or other document being read (the same flow as the Add button), and the pay to show once it's saved.
  const [jobs, setJobs] = useState<ReadJob[] | null>(null);
  const [jumpTo, setJumpTo] = useState<string | null>(null);
  // Last "Balance this pay": what changed and why, plus what to restore on Undo.
  const [optimiseOpen, setOptimiseOpen] = useState(false);
  // An account's amount for this pay only, being changed from "What's different this pay".
  const [adjEdit, setAdjEdit] = useState<AdjEdit | null>(null);
  const [optUndo, setOptUndo] = useState<OptimiseUndo | null>(() => readOptimiseUndo());
  // Undo puts back only what Optimise changed, so anything you've edited since stays.
  function undoOptimise() {
    if (!optUndo) return;
    update((b) => { undoAllocation(b, optUndo); return b; });
    clearOptimiseUndo(); setOptUndo(null);
  }
  const [balanced, setBalanced] = useState<LastBalance | null>(null);
  // Account settings opened from a payday-split card (Payday send tab).
  const [editAccount, setEditAccount] = useState<{ id: string; tab: AccountTab } | null>(null);
  const slipRef = useRef<HTMLInputElement>(null);

  // Everything shown for this pay and view (logic/plannerFigures.ts); the page only draws it.
  const fig = useMemo(() => plannerFigures(budget, period, mode, today, balanced), [budget, period, mode, today, balanced]);
  const {
    plan, isCurrent, avg, split, spanDays, v, estimated, known, estimateWhy, notes, usualTotal, totalBudgeted, leftover,
    shorts, cards, slices, upcoming, pending, needsBalance, adjustments, byHand, canOptimise, extrasHere, autoHere, passedNote,
  } = fig;
  const parts = moneyParts(leftover);
  const splitParts = moneyParts(totalBudgeted);
  const thisPay = budget.overrides?.[period.start] ?? {};
  const shortAccounts = pending.shortAccounts;
  // How amounts are shown, for each card in the payday split.
  const view: PlannerView = { mode, avg, split, longRun: fig.longRun, known, v, leftover, planned: fig.planned, period, today };
  const undoHere = optUndo?.periodStart === period.start ? optUndo : null;
  const canReset = adjustments.length > 0 || modesChangedIn(period.start);

  /** Set (or with null, remove) an account's amount for this pay only. */
  function setThisPay(id: string, amount: Cents | null) {
    update((b) => { setPayAmount(b, period.start, id, amount); return b; });
    setAdjEdit(null);
  }
  function saveAdj() {
    if (!adjEdit) return;
    const c = parseMoney(adjEdit.text);
    if (c === null || c < 0) { setAdjEdit({ ...adjEdit, err: true }); return; }
    setThisPay(adjEdit.id, c);
  }

  function balanceThisPay() {
    // Builds on what's there (your own one-pay changes stay), so it also works as Re-balance.
    // `pending` is the same calculation, already done for this budget and pay.
    const result = pending;
    // Remember the payday amounts balancing changed (e.g. Fixed → Steady), so Reset to defaults can put them back.
    if (result.toSteady.length) rememberModes(period.start, result.toSteady);
    update((b) => { applyBalance(b, period, result); return b; });
    const earlier = balanced?.periodStart === period.start ? balanced.result.changes.filter((c) => !result.changes.some((x) => x.accountId === c.accountId)) : [];
    setBalanced({ periodStart: period.start, result: { ...result, changes: [...earlier, ...result.changes], toSteady: [...(balanced?.periodStart === period.start ? balanced.result.toSteady : []), ...result.toSteady] } });
  }
  /** Back to defaults for this pay: no one-pay adjustments, and payday amounts balancing changed put back. */
  function resetToDefaults() {
    const modes = takeModes(period.start);
    update((b) => { resetPay(b, period.start, modes); return b; });
    setBalanced(null);
    // Reset removes this pay's one-pay changes, Optimise's included, so there's nothing left to undo.
    if (optUndo?.periodStart === period.start) { clearOptimiseUndo(); setOptUndo(null); }
  }

  function savePay() {
    const cleared = (payEdit ?? '').trim() === '';
    const c = cleared ? null : parseMoney(payEdit ?? '');
    if (!cleared && (c === null || c < 0)) return; // not an amount: keep editing rather than wiping the pay
    update((b) => {
      if (c === null) {
        delete b.payActuals[period.start];
        // Payday itself can be re-planned; once the day has passed the split stays locked.
        if (!(period.start < today)) unfreezePaySplit(b, period.start);
      } else {
        b.payActuals[period.start] = c;
        freezePaySplit(b, period, today);
      }
      return b;
    });
    setPayEdit(null);
  }

  // Once a payslip is saved, show that pay (its payday may have moved, so this waits for the saved budget).
  useEffect(() => {
    if (!jumpTo) return;
    setOffset(offsetOf(budget, jumpTo));
    setJumpTo(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [budget, jumpTo]);

  /** How many pays after the next one to come a pay is (negative = before it), in budget `b`. */
  function offsetOf(b: typeof budget, start: string): number {
    let n = 0;
    let p = upcomingPayPeriod(b, today);
    const dir = start > p.start ? 1 : -1;
    while (p.start !== start && Math.abs(n) < 240) { p = shiftPeriod(p, dir, b.settings); n += dir; }
    return p.start === start ? n : offset;
  }

  return (
    <>
      <PayNav><ViewModes /></PayNav>

      <section className="grid-2 planner-hero">
        <div className="card stack gap-16">
          <div>
            <div className="between nowrap top">
              <div className="min0">
                <p className="eyebrow">{!known ? 'Total budgeted' : split
                  ? `Left after plan, per ${mode} · this pay's ${period.days} days are ${(period.days / spanDays).toFixed(1)} ${mode}s`
                  : mode === 'month' ? 'Left after plan, per month (average of the next 12 pays)'
                  : mode === 'year' ? 'Left after plan over the next 12 pays'
                  : 'Left after your plan'}</p>
                <p className={`big ${known && leftover < 0 ? 'neg' : ''}`} style={{ marginTop: 6 }}>
                  {known ? parts.main : splitParts.main}<small>{known ? parts.cents : splitParts.cents}</small>
                </p>
              </div>
              {/* Put what's left over to work (once the pay is balanced), or change where it went. */}
              {!avg && known && (canOptimise || undoHere || extrasHere) && (
                <button className="icon-btn brand has-tip tip-left"
                  data-tip={undoHere || extrasHere ? 'Optimise: change where the leftover went' : 'Optimise: choose where the leftover goes'}
                  aria-label={undoHere || extrasHere ? 'Optimise: change where the leftover went' : 'Optimise: choose where the leftover goes'}
                  onClick={() => setOptimiseOpen(true)}>
                  <Icon name="wand" />
                </button>
              )}
            </div>
            {(!known || plan.leftover < 0) && (
              <p className="small muted" style={{ marginTop: 8 }}>
                {!known ? 'Add your pay to see what’s left.' : `You've budgeted ${cash(-plan.leftover)} more than this pay.`}
              </p>
            )}
            {!avg && undoHere && (
              <p className="small" style={{ marginTop: 6 }}>
                Leftover put to work ({undoHere.label}). <button className="btn link" onClick={() => setOptimiseOpen(true)}>Edit</button>
                {' · '}<button className="btn link" onClick={undoOptimise}>Undo</button>
              </p>
            )}
          </div>

          <div className="pay-stats">
            <div className="stat">
              {/* Wraps (buttons drop below, right-aligned) when the label and buttons don't fit,
                  rather than pushing the buttons out of the card. */}
              <div className="between gap-6" style={{ minHeight: 32, rowGap: 4 }}>
                {/* "(estimate)" until a real payslip is added. */}
                <span className="small muted nowrap" title={estimated ? estimateWhy : undefined}>
                  {plan.payIsActual ? 'Pay received' : estimated ? 'Pay (estimate)' : 'Pay'}
                </span>
                {payEdit === null && (
                  <span className="row nowrap gap-4" style={{ marginLeft: 'auto' }}>
                    <button className="icon-btn mini has-tip" data-tip={plan.payIsActual ? 'Change pay' : 'Type in your pay'} aria-label={plan.payIsActual ? 'Change pay' : 'Type pay'}
                      onClick={() => setPayEdit(centsToInput(plan.pay))}><Icon name="edit" size={16} /></button>
                    <button className="icon-btn mini has-tip" data-tip="Upload payslip" aria-label="Upload payslip"
                      onClick={() => slipRef.current?.click()}><Icon name="upload" size={16} /></button>
                  </span>
                )}
              </div>
              <input ref={slipRef} type="file" accept="application/pdf,image/*,.csv,text/csv" multiple hidden
                onChange={(e) => {
                  const files = [...(e.target.files ?? [])].slice(0, 12);
                  if (files.length) setJobs(files.map((f) => startRead(f, budget)));
                  e.target.value = '';
                }} />
              {payEdit === null ? (
                <b className={known ? '' : 'muted'}>{known ? cash(v(plan.pay)) : 'Not in yet'}</b>
              ) : (
                <>
                  <input className="input" aria-label="Actual pay" inputMode="decimal" autoFocus value={payEdit} onChange={(e) => setPayEdit(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') savePay(); if (e.key === 'Escape') setPayEdit(null); }}
                    style={{ marginTop: 4, minHeight: 36 }} />
                  <span className="row gap-6" style={{ marginTop: 6 }}>
                    <button className="btn small primary" onClick={savePay}>Save</button>
                    <button className="btn small" onClick={() => setPayEdit(null)}>Cancel</button>
                  </span>
                </>
              )}
            </div>
            <div className="stat">
              {/* Same height of label row as Pay (which has icons), so the two amounts line up. */}
              <div className="row" style={{ minHeight: 32 }}><span className="small muted">Total budgeted</span></div>
              <b>{cash(totalBudgeted)}</b>
            </div>
          </div>
          {jobs && (
            <ErrorBoundary key={jobs.map((j) => j.file.name + j.file.lastModified).join('|')} onClose={() => { jobs.forEach((j) => j.cancel()); setJobs(null); }}>
              <Suspense fallback={null}>
                <UploadQueue jobs={jobs} onClose={() => setJobs(null)} onPayslip={setJumpTo} />
              </Suspense>
            </ErrorBoundary>
          )}

          {/* Balancing is automatic, so it only speaks up when there's something left to do. */}
          {!avg && known && (autoHere ? plan.leftover < 0 : needsBalance || byHand.length > 0) && (
            <div className={`${autoHere || plan.leftover < 0 ? 'alert' : 'tip'} small stack gap-8`} role="status">
              <span>
                {autoHere
                  ? <><b>Still {cash(-plan.leftover)} short.</b> Every safe trim has been made; the rest needs a bigger change, like lower rent or bills.</>
                  : needsBalance
                    ? <><b>{adjustments.length ? 'Needs re-balancing' : 'Not balanced yet'}.</b> This pay is already split (or more than 12 pays away), so it isn't balanced automatically.{shortAccounts.length ? ` ${shortAccounts.map((x) => `${x.name} needs ${cash(x.short)} more`).join(' and ')}.` : ''}</>
                    : passedNote ?? 'Adjusted by hand for this pay.'}
              </span>
              {!autoHere && (needsBalance || canReset) && (
                <span className="row wrap gap-8">
                  {needsBalance && <button className="btn small primary" onClick={balanceThisPay}>{adjustments.length ? 'Re-balance' : 'Balance this pay'}</button>}
                  {canReset && <button className="btn small" onClick={resetToDefaults}>Reset to defaults</button>}
                </span>
              )}
              {!autoHere && needsBalance && passedNote && <span>{passedNote}</span>}
            </div>
          )}

          {/* A detail, so it's behind a click; it opens by itself when the pay is short. */}
          {!avg && (notes.length > 0 || usualTotal > plan.pay) && (
            <PayNotes notes={notes} usualTotal={usualTotal} pay={plan.pay} short={plan.leftover < 0} thisPay={thisPay}
              adjEdit={adjEdit} setAdjEdit={setAdjEdit} saveAdj={saveAdj} resetAdj={(id) => setThisPay(id, null)} />
          )}
        </div>

        <div className="card stack gap-16">
          <div className="card-head">
            <h2 className="h2">{split ? `Where this pay goes, per ${mode}` : mode === 'month' ? 'Where pay goes, per month' : mode === 'year' ? 'Where pay goes over a year' : 'Where this pay goes'}</h2>
            <a href="#/insights" className="btn small ghost">By account</a>
          </div>
          {/* The chart sits in the middle of whatever height the card has, so both cards end level
              (unless "What's different" is open: then this card keeps its own height, see .planner-hero). */}
          <div className="chart-row">
            <Donut slices={slices} size={150}>
              <span className="xs muted">Budgeted</span>
              <b className="fig-sm">{cash(totalBudgeted, { whole: true })}</b>
            </Donut>
            <Legend slices={slices} amounts />
          </div>
        </div>
      </section>

      {!avg && shorts.length > 0 && (
        <div className="alert" role="status">
          <Icon name="alert" />
          <span>
            {shorts.map((s) => `${s.account.name} needs ${cash(-(s.diff ?? 0))} more`).join(' · ')}
            {' '}this {period.days}-day period.
            {shorts.some((s) => s.account.kind === 'bank' && !budget.balances?.[s.account.id]) && (
              <> That's unless it's already in {shorts.length === 1 ? 'the account' : 'those accounts'}: <a href="#/accounts">enter the balance in Accounts</a> to check.</>
            )}
          </span>
        </div>
      )}

      <section className="stack gap-12">
        <div className="card-head">
          <h2 className="h2">Payday split</h2>
          <a href="#/accounts/deposits" className="btn small ghost">Edit accounts</a>
        </div>

        {cards.length === 0 && <p className="note">Nothing is sent on from your pay yet. Use Add for a cost, a savings goal or a debt, and it shows here.</p>}
        <div className="acc-grid">
          {cards.map((a) => (
            <PaydayCard key={a.account.id} budget={budget} a={a} view={view}
              why={notes.find((n) => n.a.account.id === a.account.id)?.why ?? []}
              isOpen={openCard === a.account.id} onOpen={() => setOpenCard(a.account.id)} onClose={() => setOpenCard(null)}
              onEdit={(tab) => { setOpenCard(null); setEditAccount({ id: a.account.id, tab }); }} />
          ))}
        </div>
      </section>

      {editAccount && (() => {
        const acc = budget.accounts.find((x) => x.id === editAccount.id);
        return acc ? createPortal(
          <AccountEditModal account={acc} tab={editAccount.tab} onClose={() => setEditAccount(null)} />,
          document.body,
        ) : null;
      })()}

      {!avg && (
        <div className="planner-lower two">
          <WeeksView budget={budget} period={period} plan={plan} />

          <DueList accounts={budget.accounts} upcoming={upcoming} showAll={showAllDues} onToggle={() => setShowAllDues(!showAllDues)}
            isCurrent={isCurrent} today={today} />
        </div>
      )}
      {optimiseOpen && <OptimiseModal period={period} leftover={plan.leftover} previous={undoHere} onClose={() => setOptimiseOpen(false)} onApplied={(u) => setOptUndo(u)} />}
    </>
  );
}

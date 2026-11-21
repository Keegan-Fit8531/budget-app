import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { startRead, type ReadJob } from '../../services/reader/job';
import { applyBalance, autoPays, balancePay, restoreOverrides, type BalanceResult } from '../../engine/rebalance';
import { freezePaySplit, unfreezePaySplit } from '../../engine/balances/freeze';
import { isHoldDisplayAccount } from '../debts/logic/funding';
import { owed } from '../debts/logic/amounts';
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
import { existingExtras, undoAllocation } from './logic/allocate';
import { modesChangedIn, rememberModes, takeModes } from './logic/modeMemory';
import { fmtShort, monthName, todayISO } from '../../core/dates';
import { averageSplit, planFor, plannedAverage } from '../../engine/plan';
import { convert, type View } from '../../engine/frequency';
import { shiftPeriod, upcomingPayPeriod } from '../../engine/periods';
import { cash, moneyParts, centsToInput, parseMoney } from '../../core/money';
import { useBudget } from '../../state/store';
import type { Cents, PaydayMode } from '../../core/types';

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
  const [balanced, setBalanced] = useState<{ periodStart: string; result: BalanceResult } | null>(null);
  // Account settings opened from a payday-split card (Payday send tab).
  const [editAccount, setEditAccount] = useState<{ id: string; tab: AccountTab } | null>(null);
  const slipRef = useRef<HTMLInputElement>(null);

  // The first pay the budget covers: today's, or the budget start if that's later .
  const plan = useMemo(() => planFor(budget, period), [budget, period]);
  // The pay you're in now (the Planner opens on the next one to come).
  const isCurrent = period.start <= today && today <= period.end;
  const avg = mode !== 'period';
  // Week / Fortnight: this pay, split into weeks (or fortnights) by its number of days.
  // Month avg / Year: what's planned over the next 12 pays, averaged (or added up for the year).
  const split = mode === 'week' || mode === 'fortnight';
  const longRun = mode === 'month' || mode === 'year';
  const spanDays = mode === 'week' ? 7 : 14;
  const v = (c: Cents) => (split ? Math.round((c * spanDays) / period.days) : avg ? convert(c, 'monthly', mode as View) : c);

  /** Only show what's left (or short) once the real pay is in. */
  // Show what's left once pay is in — or, before the payslip arrives, estimated from the last pay received.
  const estimated = !plan.payIsActual && !!plan.payEstimateFrom;
  const known = plan.payIsActual || estimated;
  // Payday itself still counts as "to come" (pay can land late); only the day after is "already split".
  const paydayEnded = plan.period.start < today;
  // Why the pay is an estimate: shown on hover over "Pay (estimate)".
  const estimateWhy = estimated
    ? `Using ${monthName(plan.payEstimateFrom!)}'s pay of ${cash(plan.pay)}. ${paydayEnded ? 'Payday has passed: upload the payslip to make it exact.' : `Upload the payslip when it arrives on ${fmtShort(period.start)}.`}`
    : '';
  // What each account usually gets a month (worked out once per change, not per card).
  const usualSplit = useMemo(() => new Map(plan.accounts.map((a) => [a.account.id, averageSplit(budget, a.account.id)])), [budget, plan]);
  const usualOf = (id: string) => usualSplit.get(id) ?? 0;
  // Notes on what's unusual this pay: each account sending noticeably more or less than normal, and why
  // (an extra week, a yearly or one-off cost falling in it, or an adjustment made for this pay only).
  const realItems = new Set(budget.items.map((i) => i.id));
  const thisPay = budget.overrides?.[period.start] ?? {};
  /** Set (or with null, remove) an account's amount for this pay only. */
  function setThisPay(id: string, amount: Cents | null) {
    update((b) => {
      const o = { ...(b.overrides?.[period.start] ?? {}) };
      if (amount === null) delete o[id]; else o[id] = amount;
      b.overrides = b.overrides ?? {};
      if (Object.keys(o).length) b.overrides[period.start] = o; else delete b.overrides[period.start];
      // Locked cycle: keep the frozen split in step with a hand edit.
      if (b.splitSent?.[period.start]) {
        if (amount === null) delete b.splitSent[period.start][id];
        else b.splitSent[period.start][id] = amount;
      }
      return b;
    });
    setAdjEdit(null);
  }
  function saveAdj() {
    if (!adjEdit) return;
    const c = parseMoney(adjEdit.text);
    if (c === null || c < 0) { setAdjEdit({ ...adjEdit, err: true }); return; }
    setThisPay(adjEdit.id, c);
  }
  const notes = plan.accounts
    .filter((a) => a.account.id !== budget.settings.payAccountId)
    .map((a) => {
      const usual = usualOf(a.account.id);
      const why: string[] = [];
      for (const x of a.breakdown) {
        if (!realItems.has(x.item.id)) continue;
        const f = x.item.frequency;
        if (f === 'yearly' || f === 'once') why.push(`${x.item.name} (${f === 'yearly' ? 'yearly' : 'one-off'}, ${cash(x.item.amount * x.count)}) falls in this pay`);
        else if (f === 'weekly' && x.count >= 5) why.push(`${x.count} weeks of ${x.item.name} instead of 4`);
        else if (f === 'fortnightly' && x.count >= 3) why.push(`${x.count} lots of ${x.item.name} instead of 2`);
      }
      if (a.usual !== undefined && a.usual !== a.funded) {
        why.push(budget.autoBalanced?.[period.start]?.[a.account.id]?.reason
          ?? (balanced?.periodStart === period.start ? balanced.result.changes.find((c) => c.accountId === a.account.id)?.reason : undefined)
          ?? `Adjusted for this pay only (normally ${cash(a.usual)}).`);
      }
      return { a, usual, extra: a.funded - usual, why };
    })
    .filter((x) => Math.abs(x.extra) > 2000 || x.why.length > 0)
    .sort((x, y) => Math.abs(y.extra) - Math.abs(x.extra));
  const usualTotal = plan.accounts.filter((a) => a.account.id !== budget.settings.payAccountId)
    .reduce((t, a) => t + usualOf(a.account.id), 0);
  // Average views (week, fortnight, month, year): what's really planned over the next 12 pays, averaged.
  const planned = useMemo(() => (longRun
    ? new Map(plan.accounts.map((a) => [a.account.id, plannedAverage(budget, a.account.id, today)]))
    : null), [longRun, budget, plan, today]);
  const plannedTotal = planned ? plan.accounts.filter((a) => a.account.id !== budget.settings.payAccountId)
    .reduce((t, a) => t + (planned.get(a.account.id)?.sent ?? 0), 0) : 0;
  const totalBudgeted = split ? v(plan.totalSplit) : longRun ? v(plannedTotal) : plan.totalSplit;
  const leftover = split ? v(plan.leftover) : longRun ? v(plan.pay - plannedTotal) : plan.leftover;
  const parts = moneyParts(leftover);
  const splitParts = moneyParts(totalBudgeted);
  const payAccountName = budget.accounts.find((a) => a.id === budget.settings.payAccountId)?.name ?? 'your main account';
  const shorts = plan.accounts.filter((a) => a.diff !== null && a.diff < 0);

  // The pay account (Weekly allowance) isn't part of the split — what's left there is the big number above.
  // Hold-display debts (Gem Visa with money in Misc bills) stay on the payday split even when this
  // pay's figure is $0 — they still show how much is being sent / stored, with the hold note.
  const cards = plan.accounts.filter((a) => {
    if (a.account.id === budget.settings.payAccountId) return false;
    if (a.funded !== 0 || a.need !== 0) return true;
    if (!isHoldDisplayAccount(budget, a.account.id)) return false;
    return (budget.debts ?? []).some((d) => d.accountId === a.account.id && !d.payroll && owed(d) > 0);
  });

  // The chart follows the view: this pay, this pay per week / fortnight, or the average of the next 12 pays
  // per month / added up for the year (the same amounts the cards and Total budgeted show). It's by group;
  // each account's own amount is on its card below, and its share is on Insights.
  // Hold-display debts (Gem in Misc bills): count under Debt, and take that slice out of the hold account
  // so Essentials isn't double-counting the same money.
  const sentOf = (a: (typeof plan.accounts)[number]) => Math.max(0, longRun ? v(planned?.get(a.account.id)?.sent ?? 0) : v(a.funded));
  const holdOut = new Map<string, number>();
  for (const a of plan.accounts) {
    if (a.account.id === budget.settings.payAccountId || !isHoldDisplayAccount(budget, a.account.id)) continue;
    const amt = sentOf(a);
    if (amt <= 0) continue;
    for (const d of budget.debts ?? []) {
      if (d.accountId !== a.account.id || !d.holdAccountId) continue;
      holdOut.set(d.holdAccountId, (holdOut.get(d.holdAccountId) ?? 0) + amt);
    }
  }
  const chartOf = (a: (typeof plan.accounts)[number]) => {
    if (a.account.id === budget.settings.payAccountId) return 0;
    if (isHoldDisplayAccount(budget, a.account.id)) return sentOf(a);
    return Math.max(0, sentOf(a) - (holdOut.get(a.account.id) ?? 0));
  };
  const chartAccounts = plan.accounts.filter((a) => a.account.id !== budget.settings.payAccountId);
  const grouped = new Set(budget.groups.map((g) => g.id));
  const slices = [
    ...budget.groups.map((g) => ({ label: g.name, color: g.color, value: chartAccounts.filter((a) => a.account.groupId === g.id).reduce((t, a) => t + chartOf(a), 0) })),
    { label: 'Other', color: 'var(--muted)', value: chartAccounts.filter((a) => !grouped.has(a.account.groupId)).reduce((t, a) => t + chartOf(a), 0) },
  ].filter((x) => x.value > 0);

  // How amounts are shown, for each card in the payday split.
  const view: PlannerView = { mode, avg, split, longRun, known, v, leftover, planned, period, today };

  const upcoming = plan.dues.filter((d) => !isCurrent || d.date >= today);

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
    update((b) => {
      restoreOverrides(b, period.start, undefined);
      for (const [id, m] of Object.entries(modes)) {
        const l = b.split.find((x) => x.accountId === id);
        if (l) l.mode = m as PaydayMode;
      }
      return b;
    });
    setBalanced(null);
    // Reset removes this pay's one-pay changes, Optimise's included, so there's nothing left to undo.
    if (optUndo?.periodStart === period.start) { clearOptimiseUndo(); setOptUndo(null); }
  }
  const adjustments = plan.accounts.filter((a) => a.usual !== undefined && a.usual !== a.funded);
  // The ones you made yourself. What automatic balancing set was in place before payday, so payday sent
  // those amounts: once the pay has been split there's nothing left to do about them.
  const autoSet = budget.autoBalanced?.[period.start] ?? {};
  const byHand = adjustments.filter((a) => autoSet[a.account.id]?.to !== a.funded);
  // What balancing would still do now: if anything, the pay needs (re-)balancing.
  const pending = useMemo(() => balancePay(budget, period), [budget, period]);
  const shortAccounts = pending.shortAccounts;
  const needsBalance = plan.leftover < 0 || shortAccounts.length > 0 || pending.changes.length > 0 || pending.toSteady.length > 0;
  // Optimise hands out what's left once the pay is balanced (short accounts and the 5-week buffer come first).
  const undoHere = optUndo?.periodStart === period.start ? optUndo : null;
  // From $1: rounded accounts (e.g. the wedding fund to $50) often leave a few dollars to put somewhere.
  const canOptimise = !avg && !needsBalance && plan.leftover >= 100;
  // Extra already added to goals, debts or the allowance for this pay only: Optimise can show and change it.
  const extrasHere = useMemo(() => !avg && !!existingExtras(budget, period), [avg, budget, period]);
  // Automatic balancing looks after today's pay (while it is still payday) and the next 11; after that, by hand.
  const autoHere = autoPays(budget, today).some((p) => p.start === period.start);
  const hasModeChanges = modesChangedIn(period.start);
  const canReset = adjustments.length > 0 || hasModeChanges;
  // From the day after payday, a change isn't re-sent with the split — make it as a transfer instead.
  const passedNote = paydayEnded && byHand.length > 0
    ? `This pay was already split on ${fmtShort(period.start)}. A change made since then isn't sent by payday, so make it as a transfer now, before ${fmtShort(plan.dues.find((d) => d.date >= today)?.date ?? period.end)}: move the money from the accounts being trimmed (or from what's left in ${payAccountName}) to the ones being topped up.`
    : undefined;

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
      <header className="page-head">
        <PayNav />
        <ViewModes />
      </header>

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

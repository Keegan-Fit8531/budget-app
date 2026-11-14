import { Fragment, useMemo, useRef, useState } from 'react';
import { readPayslipPdf } from '../lib/payslip';
import { applyBalance, autoPays, balancePay, restoreOverrides, type BalanceResult } from '../lib/rebalance';
import { accountMode, leftoverBeforeBudget, topsUp } from '../lib/balances';
import { Donut, Legend } from '../components/Donut';
import { Icon } from '../components/Icon';
import { AccIcon, Disclosure, Dot } from '../components/ui';
import { WeeksView } from '../components/WeeksView';
import { PayNav, useViewPeriod, ViewModes } from '../lib/period';
import { clearOptimiseUndo, OptimiseModal, readOptimiseUndo, type OptimiseUndo } from '../components/OptimiseModal';
import { undoAllocation } from '../lib/allocate';
import { recordPayslip } from '../lib/documents';
import { addDays, fmtDay, fmtShort, monthName, todayISO } from '../lib/dates';
import {
  averageSplit, convert, firstBudgetPay, isAuto, isSetAside, planFor, plannedAverage, shiftPeriod, upcomingPayPeriod, type View,
} from '../lib/engine';
import { cash, moneyParts, centsToInput, parseMoney } from '../lib/money';
import { useBudget } from '../lib/store';
import type { Cents, PaydayMode } from '../lib/types';

const MODES_KEY = 'paydays.balance.modes';

/** Payments in date order, grouped by day. */
function dayGroups<T extends { date: string }>(list: T[]): [string, T[]][] {
  const m = new Map<string, T[]>();
  for (const d of list) m.set(d.date, [...(m.get(d.date) ?? []), d]);
  return [...m];
}

export function Planner() {
  const { budget, update } = useBudget();
  const today = todayISO();
  const { offset, setOffset, period, mode } = useViewPeriod();
  const [showAllDues, setShowAllDues] = useState(false);
  // The account card whose details pop-up is open.
  const [openCard, setOpenCard] = useState<string | null>(null);
  const [payEdit, setPayEdit] = useState<string | null>(null);
  const [slipMsg, setSlipMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // Last "Balance this pay": what changed and why, plus what to restore on Undo.
  const [optimiseOpen, setOptimiseOpen] = useState(false);
  const [optUndo, setOptUndo] = useState<OptimiseUndo | null>(() => readOptimiseUndo());
  // Undo puts back only what Optimise changed, so anything you've edited since stays.
  function undoOptimise() {
    if (!optUndo) return;
    update((b) => { undoAllocation(b, optUndo); return b; });
    clearOptimiseUndo(); setOptUndo(null);
  }
  const [balanced, setBalanced] = useState<{ periodStart: string; result: BalanceResult } | null>(null);
  const slipRef = useRef<HTMLInputElement>(null);

  // The first pay the budget covers: today's, or the budget start if that's later .
  const plan = useMemo(() => planFor(budget, period), [budget, period]);
  const isCurrent = offset === 0;
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
  const paydayPassed = plan.period.start <= today;
  // Why the pay is an estimate: on hover, and shown under the pay when the pill is tapped.
  const [estOpen, setEstOpen] = useState(false);
  const estimateWhy = estimated
    ? `Using ${monthName(plan.payEstimateFrom!)}'s pay of ${cash(plan.pay)}. ${paydayPassed ? 'Payday has passed: upload the payslip to make it exact.' : `Upload the payslip when it arrives on ${fmtShort(period.start)}.`}`
    : '';
  // What each account usually gets a month (worked out once per change, not per card).
  const usualSplit = useMemo(() => new Map(plan.accounts.map((a) => [a.account.id, averageSplit(budget, a.account.id)])), [budget, plan]);
  const usualOf = (id: string) => usualSplit.get(id) ?? 0;
  // Notes on what's unusual this pay: each account sending noticeably more or less than normal, and why
  // (an extra week, a yearly or one-off cost falling in it, or an adjustment made for this pay only).
  const realItems = new Set(budget.items.map((i) => i.id));
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
  const cards = plan.accounts.filter((a) =>
    a.account.id !== budget.settings.payAccountId && (a.funded !== 0 || a.need !== 0));

  // The chart follows the view: this pay, this pay per week / fortnight, or the average of the next 12 pays
  // per month / added up for the year (the same amounts the cards and Total budgeted show). It's by group;
  // each account's own amount is on its card below, and its share is on Insights.
  const sentOf = (a: (typeof plan.accounts)[number]) => Math.max(0, longRun ? v(planned?.get(a.account.id)?.sent ?? 0) : v(a.funded));
  const split_ = plan.accounts.filter((a) => a.account.id !== budget.settings.payAccountId);
  const grouped = new Set(budget.groups.map((g) => g.id));
  const slices = [
    ...budget.groups.map((g) => ({ label: g.name, color: g.color, value: split_.filter((a) => a.account.groupId === g.id).reduce((t, a) => t + sentOf(a), 0) })),
    { label: 'Other', color: 'var(--muted)', value: split_.filter((a) => !grouped.has(a.account.groupId)).reduce((t, a) => t + sentOf(a), 0) },
  ].filter((x) => x.value > 0);

  const debtAccounts = new Set((budget.debts ?? []).map((d) => d.accountId));
  const goalAccounts = new Set((budget.savings ?? []).map((g) => g.accountId));

  const upcoming = plan.dues.filter((d) => !isCurrent || d.date >= today);
  const dues = showAllDues ? upcoming : upcoming.slice(0, 8);

  function balanceThisPay() {
    // Builds on what's there (your own one-pay changes stay), so it also works as Re-balance.
    // `pending` is the same calculation, already done for this budget and pay.
    const result = pending;
    // Remember the payday amounts balancing changed (e.g. Fixed → Steady), so Reset to defaults can put them back.
    if (result.toSteady.length) {
      try {
        const all = JSON.parse(localStorage.getItem(MODES_KEY) ?? '{}') as Record<string, Record<string, string>>;
        const mine = all[period.start] ?? {};
        for (const t of result.toSteady) if (!(t.accountId in mine)) mine[t.accountId] = t.was;
        all[period.start] = mine;
        localStorage.setItem(MODES_KEY, JSON.stringify(all));
      } catch { /* ignore */ }
    }
    update((b) => { applyBalance(b, period, result); return b; });
    const earlier = balanced?.periodStart === period.start ? balanced.result.changes.filter((c) => !result.changes.some((x) => x.accountId === c.accountId)) : [];
    setBalanced({ periodStart: period.start, result: { ...result, changes: [...earlier, ...result.changes], toSteady: [...(balanced?.periodStart === period.start ? balanced.result.toSteady : []), ...result.toSteady] } });
  }
  /** Back to defaults for this pay: no one-pay adjustments, and payday amounts balancing changed put back. */
  function resetToDefaults() {
    let modes: Record<string, string> = {};
    try {
      const all = JSON.parse(localStorage.getItem(MODES_KEY) ?? '{}') as Record<string, Record<string, string>>;
      modes = all[period.start] ?? {};
      delete all[period.start];
      localStorage.setItem(MODES_KEY, JSON.stringify(all));
    } catch { /* ignore */ }
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
  // What balancing would still do now: if anything, the pay needs (re-)balancing.
  const pending = useMemo(() => balancePay(budget, period), [budget, period]);
  const shortAccounts = pending.shortAccounts;
  const needsBalance = plan.leftover < 0 || shortAccounts.length > 0 || pending.changes.length > 0 || pending.toSteady.length > 0;
  // Optimise hands out what's left once the pay is balanced (short accounts and the 5-week buffer come first).
  const undoHere = optUndo?.periodStart === period.start ? optUndo : null;
  const canOptimise = !avg && !needsBalance && plan.leftover > 5000;
  // Automatic balancing looks after the next 12 pays; a pay already split (or further out) is done by hand.
  const autoHere = autoPays(budget, today).some((p) => p.start === period.start);
  const hasModeChanges = (() => { try { return !!JSON.parse(localStorage.getItem(MODES_KEY) ?? '{}')[period.start]; } catch { return false; } })();
  const canReset = adjustments.length > 0 || hasModeChanges;
  // A pay that's already been split can't be re-sent, so changes to it are made as transfers.
  const passedNote = paydayPassed && adjustments.length > 0
    ? `This pay was already split on ${fmtShort(period.start)}, so make these as transfers now, before ${fmtShort(plan.dues.find((d) => d.date >= today)?.date ?? period.end)}: move the money from the accounts being trimmed (or from what's left in ${payAccountName}) to the ones being topped up.`
    : undefined;

  function savePay() {
    const cleared = (payEdit ?? '').trim() === '';
    const c = cleared ? null : parseMoney(payEdit ?? '');
    if (!cleared && (c === null || c < 0)) return; // not an amount: keep editing rather than wiping the pay
    update((b) => {
      if (c === null) delete b.payActuals[period.start]; else b.payActuals[period.start] = c;
      return b;
    });
    setPayEdit(null);
  }

  async function uploadPayslip(file: File) {
    setSlipMsg({ ok: true, text: 'Reading payslip…' });
    try {
      const slip = await readPayslipPdf(file);
      if (!slip) { setSlipMsg({ ok: false, text: 'Couldn’t find a pay day and net pay in that PDF. Is it a payslip?' }); return; }
      // Paid a day or so off the usual payday (e.g. early, before a holiday)? That payday moves to the
      // day pay really arrived, so this pay and the one before it are both worked out on their real dates.
      const record = (b: typeof budget) => recordPayslip(b, slip);
      // Worked out on a copy first, for the message and to show that pay.
      const after = structuredClone(budget);
      const { start, loan } = record(after);
      const moved = JSON.stringify(after.settings.paydayMoves ?? {}) !== JSON.stringify(budget.settings.paydayMoves ?? {});
      const p = { start };
      update((b) => { record(b); return b; });
      const diff = slip.net - budget.settings.expectedPay;
      setSlipMsg({
        ok: true,
        text: `${monthName(p.start)} pay recorded: ${cash(slip.net)}` +
          (diff === 0 ? ', exactly as expected.' : `, ${cash(Math.abs(diff))} ${diff > 0 ? 'more' : 'less'} than expected.`) +
          (moved ? ` Paid on ${fmtShort(start)}, not the usual day, so that pay now starts then and the one before it ends the day before.` : '') +
          (loan && slip.studentLoan ? ` Student loan: ${cash(slip.studentLoan)} taken off what you owe.` : ''),
      });
      setOffset(offsetOf(after, start));
    } catch {
      setSlipMsg({ ok: false, text: 'That file couldn’t be read as a PDF.' });
    } finally {
      if (slipRef.current) slipRef.current.value = '';
    }
  }

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

      <section className="grid-2">
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
              {!avg && known && (canOptimise || undoHere) && (
                <button className="icon-btn brand has-tip tip-left"
                  data-tip={undoHere ? 'Optimise: change where the leftover went' : 'Optimise: choose where the leftover goes'}
                  aria-label={undoHere ? 'Optimise: change where the leftover went' : 'Optimise: choose where the leftover goes'}
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
              <div className="between nowrap gap-6" style={{ minHeight: 32 }}>
                <span className="small muted row nowrap gap-6">
                  {plan.payIsActual ? 'Pay received' : 'Pay'}
                  {estimated && (
                    <button className="pill" title={estimateWhy} aria-expanded={estOpen} aria-label={`Estimate. ${estimateWhy}`} onClick={() => setEstOpen(!estOpen)}
                      style={{ background: 'var(--card)' }}>Estimate</button>
                  )}
                </span>
                {payEdit === null && (
                  <span className="row nowrap gap-4">
                    <button className="icon-btn mini has-tip" data-tip={plan.payIsActual ? 'Change pay' : 'Type in your pay'} aria-label={plan.payIsActual ? 'Change pay' : 'Type pay'}
                      onClick={() => setPayEdit(centsToInput(plan.pay))}><Icon name="edit" size={16} /></button>
                    <button className="icon-btn mini has-tip" data-tip="Upload payslip (PDF)" aria-label="Upload payslip"
                      onClick={() => slipRef.current?.click()}><Icon name="upload" size={16} /></button>
                  </span>
                )}
              </div>
              <input ref={slipRef} type="file" accept="application/pdf" hidden
                onChange={(e) => e.target.files?.[0] && uploadPayslip(e.target.files[0])} />
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
          {estimated && estOpen && <p className="small muted" role="status" style={{ marginTop: -6 }}>{estimateWhy}</p>}
          {slipMsg && <p className={`small ${slipMsg.ok ? '' : 'error'}`} role="status">{slipMsg.text}</p>}

          {/* Balancing is automatic, so it only speaks up when there's something left to do. */}
          {!avg && known && (autoHere ? plan.leftover < 0 : needsBalance || adjustments.length > 0) && (
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
            <Disclosure ruled wide title="What's different this pay" meta={notes.length || undefined}
              storageKey="paydays.planner.notes" forceOpen={plan.leftover < 0}>
              <div className="notes-list">
                {notes.map((x) => (
                  <div key={x.a.account.id} className="notes-row">
                    <Dot color={x.a.account.color} />
                    <span className="min0">
                      <b>{x.a.account.name}</b>
                      {x.why.map((w) => <span key={w} className="small muted block">{w}</span>)}
                      {x.why.length === 0 && <span className="small muted block">Usually about {cash(x.usual, { whole: true })}</span>}
                    </span>
                    <span className="num right">
                      <b>{cash(x.a.funded)}</b>
                      {Math.abs(x.extra) > 2000 && <span className={`small block ${x.extra > 0 ? 'neg' : 'pos'}`}>{x.extra > 0 ? '+' : '−'}{cash(Math.abs(x.extra), { whole: true })}</span>}
                    </span>
                  </div>
                ))}
                {usualTotal > plan.pay && (
                  <span className="small muted">Even in a normal pay your budget is {cash(usualTotal - plan.pay, { whole: true })} more than your pay.</span>
                )}
              </div>
            </Disclosure>
          )}
        </div>

        <div className="card stack gap-16">
          <div className="card-head">
            <h2 className="h2">{split ? `Where this pay goes, per ${mode}` : mode === 'month' ? 'Where pay goes, per month' : mode === 'year' ? 'Where pay goes over a year' : 'Where this pay goes'}</h2>
            <a href="#/insights" className="btn small ghost">By account</a>
          </div>
          {/* The chart sits in the middle of whatever height the card has, so both cards end level. */}
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
          <a href="#/deposits" className="btn small ghost">Edit accounts</a>
        </div>

        {cards.length === 0 && <p className="note">Nothing is sent on from your pay yet. Use Add for a cost, a savings goal or a debt, and it shows here.</p>}
        <div className="acc-grid">
          {cards.map((a) => {
            const isPay = a.account.id === budget.settings.payAccountId;
            const auto = isAuto(budget, a.account.id);
            const steadyMode = accountMode(budget, a.account.id) === 'smooth';
            const funded = !avg ? a.funded : isPay ? leftover : split ? v(a.funded) : v(planned?.get(a.account.id)?.sent ?? 0);
            const need = split ? v(a.need) : longRun ? v(planned?.get(a.account.id)?.need ?? 0) : a.need;
            // With a balance entered, the pill shows what the account ends the period with.
            const ends = !avg ? a.endBalance : undefined;
            const diff = ends !== undefined ? null : a.diff === null || auto ? null : funded - need;
            // Money put aside on payday (a WOF, tyres) isn't a payment: it's counted on its own.
            const paying = a.dues.filter((d) => !isSetAside(d.item));
            const asideTotal = a.need - paying.reduce((t, d) => t + d.item.amount, 0);
            const asidePart = asideTotal > 0 ? `${cash(asideTotal)} put aside` : '';
            const billBreakdown = a.breakdown.filter((x) => !isSetAside(x.item));
            // "5 × $275" when every cost repeats the same number of times (e.g. weekly food + gas), else a count.
            const sameCount = billBreakdown.length > 0 && billBreakdown.every((x) => x.count === billBreakdown[0].count);
            const times = [sameCount && billBreakdown[0].count > 1
              ? `${billBreakdown[0].count} × ${cash(billBreakdown.reduce((s, x) => s + x.item.amount, 0))}`
              : paying.length || !asidePart ? `${paying.length} payment${paying.length === 1 ? '' : 's'} due` : '', asidePart].filter(Boolean).join(' + ');
            const detail = auto
              ? (longRun ? (steadyMode ? 'Steady' : 'Exact · average')
                : !steadyMode && topsUp(budget, a.account.id)
                  ? (a.funded < a.need ? `Exact · ${cash(a.need, { whole: true })} of bills − ${cash(a.need - a.funded, { whole: true })} already there`
                    : asidePart ? `Exact · ${times}` : `Exact · ${a.dues.length} bills, nothing left over`)
                  : `${steadyMode ? 'Steady' : 'Exact'} · ${times}`)
              : isPay
              ? (known ? 'Pay lands here · what’s left' : 'Pay lands here · shows once pay is in')
              : a.diff === null
                ? (a.account.kind === 'external' ? 'Sent on payday' : 'No costs set')
                : longRun
                  ? `${cash(need)} needed on average`
                  : sameCount && billBreakdown[0].item.frequency !== 'monthly'
                    ? times
                    : asidePart && !paying.length ? `${asidePart} · nothing paid out` : `${paying.length} costs due · ${cash(a.need)}${asidePart ? `, incl. ${asidePart}` : ''}`;
            // Everything about the account beyond its amount lives in a pop-up, opened by tapping the card.
            const adjusted = a.usual !== undefined && a.usual !== a.funded;
            // Only a problem (short) or something to act on (spare) is coloured; the rest stays quiet.
            const pill = (
              <>
                {diff !== null && diff !== 0 && (
                  <span className={`pill ${diff < 0 ? 'bad' : 'good'}`}>{diff < 0 ? `${cash(-diff, { whole: Math.abs(diff) >= 10000 })} short` : `+${cash(diff, { whole: diff >= 10000 })} spare`}</span>
                )}
                {diff === 0 && <span className="pill">Exactly right</span>}
                {ends !== undefined && (
                  <span className={`pill ${ends < 0 ? 'bad' : ''}`} title="Estimated balance at the end of this pay period">
                    {ends < 0 ? `${cash(-ends, { whole: true })} short` : `Ends ${cash(ends, { whole: true })}`}
                  </span>
                )}
              </>
            );
            const amount = <>{isPay && !known ? '—' : cash(funded)}{split && !(isPay && !known) && <small className="muted small" style={{ fontWeight: 500 }}> /{mode === 'week' ? 'wk' : 'fn'}</small>}</>;
            const amountClass = funded < 0 && (known || !isPay) ? 'neg' : '';
            const icon = <AccIcon color={a.account.color} name={a.account.kind === 'external' ? 'send' : isPay ? 'wallet' : 'bank'} />;
            // Each cost this pay (e.g. food, car gas, scooter gas, or every bill in Misc bills).
            const byName = new Map<string, { name: string; amount: Cents; dates: string[]; aside: boolean }>();
            if (!longRun) for (const d of a.dues) {
              const r = byName.get(`${isSetAside(d.item)}|${d.item.name}`) ?? { name: d.item.name, amount: 0, dates: [], aside: isSetAside(d.item) };
              r.amount += d.item.amount; r.dates.push(d.date);
              byName.set(`${r.aside}|${d.item.name}`, r);
            }
            const rows = [...byName.values()];
            // The budget's first pay starts from what the pay before it left in the account (or left short).
            const carry = avg || isPay || period.start !== firstBudgetPay(budget, today).start
              || !(budget.split.find((l) => l.accountId === a.account.id)?.mode === 'smooth' || topsUp(budget, a.account.id))
              ? 0 : leftoverBeforeBudget(budget, a.account.id);
            const why = notes.find((n) => n.a.account.id === a.account.id)?.why ?? [];
            const isDebt = debtAccounts.has(a.account.id);
            const isGoal = goalAccounts.has(a.account.id);
            const isOpen = openCard === a.account.id;
            return (
              <Fragment key={a.account.id}>
              <button className="acc-card" aria-haspopup="dialog"
                aria-label={`${a.account.name}: details`} onClick={() => setOpenCard(a.account.id)}>
                <div className="between nowrap">{icon}{pill}</div>
                <p className="acc-name">{a.account.name}</p>
                <div className="between nowrap bottom">
                  <p className={`amt ${amountClass}`}>{amount}</p>
                  <span className="acc-more" aria-hidden="true"><Icon name="info" size={18} /></span>
                </div>
              </button>
              {isOpen && (
                <div className="modal-back" onClick={() => setOpenCard(null)}>
                  <div className="modal" role="dialog" aria-modal="true" aria-labelledby="acc-title" onClick={(e) => e.stopPropagation()}>
                    <div className="between nowrap">
                      <span className="row min0">
                        {icon}
                        <span className="min0">
                          <h2 id="acc-title" className="h2">{a.account.name}</h2>
                          <span className="small muted">{monthName(period.start)} pay · {fmtShort(period.start)} – {fmtShort(period.end)}</span>
                        </span>
                      </span>
                      <button className="icon-btn plain" aria-label="Close" autoFocus onClick={() => setOpenCard(null)}><Icon name="x" /></button>
                    </div>

                    <div className="stat">
                      <div className="between nowrap">
                        <span className="small muted">{isPay ? 'Left here after the plan' : longRun ? 'Sent on average' : 'Payday sends'}</span>
                        {pill}
                      </div>
                      <b className={`fig ${amountClass}`}>{amount}</b>
                      <span className="small muted">{detail}</span>
                      {adjusted && <span className="small">Adjusted this pay · usually {cash(a.usual!)}</span>}
                      {carry !== 0 && (
                        <span className={`small ${carry < 0 ? 'neg' : 'pos'}`}>
                          {carry < 0 ? `Includes ${cash(-carry, { whole: true })} the ${monthName(shiftPeriod(period, -1, budget.settings).start)} pay left short` : `${cash(carry, { whole: true })} left from ${monthName(shiftPeriod(period, -1, budget.settings).start)} counted`}
                        </span>
                      )}
                    </div>

                    {why.length > 0 && (
                      <div className="tip small stack gap-4">
                        <b>Different this pay</b>
                        {why.map((w) => <span key={w}>{w}</span>)}
                      </div>
                    )}

                    {rows.length > 0 && (
                      <div>
                        <div className="between" style={{ marginBottom: 6 }}>
                          <h3 className="h3">{rows.length} cost{rows.length === 1 ? '' : 's'} this pay{split ? `, per ${mode}` : ''}</h3>
                          <b className="num">{cash(v(a.need))}</b>
                        </div>
                        <div className="cost-rows">
                          {rows.map((r) => {
                            const each = r.amount / r.dates.length;
                            const same = r.dates.length > 1 && Number.isInteger(each);
                            return (
                              <span key={`${r.aside}|${r.name}`} className="cost-row">
                                <span className="min0">
                                  <span className="cost-name">{r.name}</span>
                                  <span className="cost-meta muted">
                                    {r.aside ? 'Put aside on payday, stays in the account' : same ? `${r.dates.length} × ${cash(each, { whole: each % 100 === 0 })}` : r.dates.length === 1 ? fmtShort(r.dates[0]) : `${r.dates.length} payments`}
                                    {/* Week / Fortnight: say what the whole pay is, since the amount on the right is per week */}
                                    {split ? `${same ? ' =' : ' ·'} ${cash(r.amount)} this pay` : ''}
                                  </span>
                                </span>
                                <b className="num">{cash(v(r.amount))}{split && <small className="muted" style={{ fontWeight: 500 }}> /{mode === 'week' ? 'wk' : 'fn'}</small>}</b>
                              </span>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    {rows.length === 0 && !isPay && !longRun && <p className="small muted">{a.account.kind === 'external' ? 'Sent on payday; no costs come out of it.' : 'No costs come out of this account this pay.'}</p>}

                    {/* Quick links to where this account is set up. */}
                    <div className="quick-links">
                      <span className="small muted">Go to</span>
                      {isDebt && <a className="btn small" href="#/debts"><Icon name="card" size={16} /> Debt and payment plans</a>}
                      {isGoal && <a className="btn small" href="#/savings"><Icon name="piggy" size={16} /> Savings goal</a>}
                      {!isDebt && !isGoal && <a className="btn small" href={`#/deposits/${a.account.id}`}><Icon name="edit" size={16} /> {isPay ? 'Account and costs' : 'Payday amount and costs'}</a>}
                      {!isDebt && !isGoal && !isPay && a.account.kind === 'bank' && <a className="btn small" href="#/accounts"><Icon name="wallet" size={16} /> {budget.balances?.[a.account.id] ? 'Update balance' : 'Enter balance'}</a>}
                    </div>
                  </div>
                </div>
              )}
              </Fragment>
            );
          })}
        </div>
      </section>

      {!avg && (
        <div className="planner-lower two">
          <WeeksView budget={budget} period={period} plan={plan} />

          <section className="card">
            <div className="card-head" style={{ marginBottom: 8 }}>
              <h2 className="h2">{isCurrent ? 'Coming up before next pay' : 'Due this period'}</h2>
              <span className="small muted">{upcoming.length} payment{upcoming.length === 1 ? '' : 's'}</span>
            </div>
            {dues.length === 0 && <p className="muted small">Nothing else due this period.</p>}
            {/* One heading per day (Today, Tomorrow, Wed 18 Nov) with that day's total, then what's due. */}
            {dayGroups(dues).map(([date, list]) => (
              <div key={date} className="due-day">
                <div className="due-day-head">
                  <span>{date === today ? 'Today' : date === addDays(today, 1) ? 'Tomorrow' : fmtDay(date)}</span>
                  {list.length > 1 && <span className="num">{cash(list.reduce((t, d) => t + d.item.amount, 0))}</span>}
                </div>
                {list.map((d, i) => {
                  const acc = budget.accounts.find((a) => a.id === d.item.accountId);
                  return (
                    <div className="list-row" key={`${d.item.id}-${d.date}-${i}`}>
                      <Dot color={acc?.color} />
                      <span className="grow">
                        {d.item.name}
                        {acc && acc.name !== d.item.name && <span className="small muted"> · {acc.name}</span>}
                      </span>
                      <b className="num">{cash(d.item.amount)}</b>
                    </div>
                  );
                })}
              </div>
            ))}
            {upcoming.length > 8 && (
              <button className="btn small ghost" style={{ marginTop: 8 }} onClick={() => setShowAllDues(!showAllDues)}>
                {showAllDues ? 'Show fewer' : `Show all ${upcoming.length}`}
              </button>
            )}
          </section>
        </div>
      )}
      {optimiseOpen && <OptimiseModal period={period} leftover={plan.leftover} previous={undoHere} onClose={() => setOptimiseOpen(false)} onApplied={(u) => setOptUndo(u)} />}
    </>
  );
}

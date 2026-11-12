import { useMemo, useRef, useState } from 'react';
import { readPayslipPdf } from '../lib/payslip';
import { applyBalance, autoPays, balancePay, DEBT_RATIO_GUIDE, restoreOverrides, type BalanceResult } from '../lib/rebalance';
import { BalanceBox } from '../components/BalanceBox';
import { accountMode, leftoverBeforeBudget, topsUp } from '../lib/balances';
import { Donut, Legend } from '../components/Donut';
import { Icon } from '../components/Icon';
import { WeeksView } from '../components/WeeksView';
import { PayNav, useViewPeriod } from '../lib/period';
import { clearOptimiseUndo, OptimiseModal, readOptimiseUndo, type OptimiseUndo } from '../components/OptimiseModal';
import { undoAllocation } from '../lib/allocate';
import { applyPayrollDeduction } from '../lib/debts';
import { addDays, fmtDay, fmtShort, monthName, todayISO } from '../lib/dates';
import {
  averageSplit, convert, firstBudgetPay, isAuto, planFor, plannedAverage, recordPayday, shiftPeriod, upcomingPayPeriod, type View,
} from '../lib/engine';
import { cash, centsToInput, moneyParts, parseMoney } from '../lib/money';
import { useBudget } from '../lib/store';
import type { Cents, PaydayMode } from '../lib/types';

const MODES_KEY = 'paydays.balance.modes';

type Mode = 'period' | View;
const MODES: { v: Mode; label: string }[] = [
  { v: 'period', label: 'This period' },
  { v: 'week', label: 'Week' },
  { v: 'fortnight', label: 'Fortnight' },
  { v: 'month', label: 'Month avg' },
  { v: 'year', label: 'Year' },
];

/** Payments in date order, grouped by day. */
function dayGroups<T extends { date: string }>(list: T[]): [string, T[]][] {
  const m = new Map<string, T[]>();
  for (const d of list) m.set(d.date, [...(m.get(d.date) ?? []), d]);
  return [...m];
}

export function Planner() {
  const { budget, update } = useBudget();
  const today = todayISO();
  const { offset, setOffset, period } = useViewPeriod();
  const [mode, setMode] = useState<Mode>('period');
  const [showAllDues, setShowAllDues] = useState(false);
  // Which account cards have their cost list open (remembered on this device).
  const [openCosts, setOpenCosts] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem('paydays.planner.costs') ?? '[]'); } catch { return []; } });
  function toggleCosts(id: string, open: boolean) {
    setOpenCosts((cur) => {
      if (open === cur.includes(id)) return cur;
      const next = open ? [...cur, id] : cur.filter((x) => x !== id);
      try { localStorage.setItem('paydays.planner.costs', JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }
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
  // What each account usually gets a month (worked out once per change, not per card).
  const usualSplit = useMemo(() => new Map(plan.accounts.map((a) => [a.account.id, averageSplit(budget, a.account.id)])), [budget, plan]);
  const usualOf = (id: string) => usualSplit.get(id) ?? 0;
  // What makes this pay different from a normal one: accounts sending well above their usual amount.
  const drivers = plan.accounts
    .filter((a) => a.account.id !== budget.settings.payAccountId)
    .map((a) => ({ a, usual: usualOf(a.account.id), extra: a.funded - usualOf(a.account.id) }))
    .filter((x) => x.extra > 2000)
    .sort((x, y) => y.extra - x.extra)
    .slice(0, 3);
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
        why.push(budget.autoBalanced?.[period.start]?.[a.account.id]?.reason ?? `Adjusted for this pay only (normally ${cash(a.usual)}).`);
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

  const slices = plan.accounts
    .filter((a) => a.account.id !== budget.settings.payAccountId && a.funded > 0)
    .map((a) => ({ label: a.account.name, value: a.funded, color: a.account.color }));

  const debtAccounts = new Set((budget.debts ?? []).map((d) => d.accountId));
  const goalAccounts = new Set((budget.savings ?? []).map((g) => g.accountId));
  const cardHref = (id: string) => debtAccounts.has(id) ? '#/debts' : goalAccounts.has(id) ? '#/savings' : `#/deposits/${id}`;

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
  const debtIds = new Set((budget.debts ?? []).map((d) => d.accountId));
  const debtPaid = plan.accounts.filter((a) => debtIds.has(a.account.id)).reduce((t, a) => t + a.funded, 0);
  const debtRatio = plan.pay > 0 ? debtPaid / plan.pay : 0;

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
      const record = (b: typeof budget) => {
        const start = recordPayday(b, slip.payDay);
        b.payActuals[start] = slip.net;
        b.payslips = { ...(b.payslips ?? {}), [start]: slip };
        // The student loan comes out before pay: count the payslip's deduction against the loan.
        const loan = slip.studentLoan ? !!applyPayrollDeduction(b, start, slip.studentLoan) : false;
        return { start, loan };
      };
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
      <header className="between">
        <PayNav />
        <div className="seg seg-modes" role="group" aria-label="Show amounts as">
          {MODES.map((m) => (
            <button key={m.v} aria-pressed={mode === m.v} onClick={() => setMode(m.v)}>{m.label}</button>
          ))}
        </div>
      </header>

      <section className="grid-2">
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {known ? (
            <div>
              <p className="eyebrow">{split
                ? `Left after plan, per ${mode} · this pay's ${period.days} days are ${(period.days / spanDays).toFixed(1)} ${mode}s`
                : mode === 'month' ? 'Left after plan, per month (average of the next 12 pays)'
                : mode === 'year' ? 'Left after plan over the next 12 pays'
                : 'Left after your plan'}</p>
              <p className={`big ${leftover < 0 ? 'neg' : ''}`} style={{ marginTop: 6 }}>
                {parts.main}<small>{parts.cents}</small>
              </p>
              <p className="small muted" style={{ marginTop: 10 }}>
                {plan.leftover < 0
                  ? `You've budgeted ${cash(-plan.leftover)} more than this pay.`
                  : `Stays in ${payAccountName} for spending.`}
              </p>
              {!avg && plan.leftover < 0 && (
                <div className="small" style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <b>Why</b>
                  {drivers.map((x) => (
                    <span key={x.a.account.id} className="row" style={{ gap: 8 }}>
                      <span className="dot" style={{ background: x.a.account.color }} />
                      <span>{x.a.account.name}: {cash(x.a.funded)} this pay, usually about {cash(x.usual, { whole: true })} (+{cash(x.extra, { whole: true })})</span>
                    </span>
                  ))}
                  {usualTotal > plan.pay && (
                    <span className="muted">Even in a normal pay your budget is {cash(usualTotal - plan.pay, { whole: true })} more than your pay.</span>
                  )}
                  {drivers.length === 0 && usualTotal <= plan.pay && <span className="muted">A few small extras this pay add up.</span>}
                </div>
              )}
              {estimated && (
                <p className="small" style={{ marginTop: 8, display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span className="pill" style={{ background: 'var(--soft)', color: 'var(--muted)' }}>Estimate</span>
                  <span className="muted">
                    Using {monthName(plan.payEstimateFrom!)}'s pay of {cash(plan.pay)}.{' '}
                    {paydayPassed ? 'Payday has passed: upload the payslip to make it exact.' : `Upload the payslip when it arrives on ${fmtShort(period.start)}.`}
                  </span>
                </p>
              )}
            </div>
          ) : (
            <div>
              <p className="eyebrow">Total budgeted</p>
              <p className="big" style={{ marginTop: 6 }}>{splitParts.main}<small>{splitParts.cents}</small></p>
              <p className="small muted" style={{ marginTop: 10 }}>
                Upload your payslip or type your pay to see what's left.
              </p>
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,1fr))', gap: 12 }}>
            <div className="stat">
              <span className="small muted">{plan.payIsActual ? 'Pay received' : estimated ? 'Pay (estimated)' : 'Pay'}</span>
              {payEdit === null ? (
                <b className={known ? '' : 'muted'}>{known ? cash(v(plan.pay)) : 'Not in yet'}</b>
              ) : (
                <input aria-label="Actual pay" inputMode="decimal" autoFocus value={payEdit} onChange={(e) => setPayEdit(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && savePay()}
                  style={{ marginTop: 4, width: '100%', minHeight: 36, borderRadius: 8, border: '1px solid var(--line)', padding: '0 8px', background: 'var(--card)' }} />
              )}
            </div>
            <div className="stat"><span className="small muted">Total budgeted</span><b>{cash(totalBudgeted)}</b></div>
          </div>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {payEdit === null ? (
              <>
                <button className="btn" onClick={() => slipRef.current?.click()}>Upload payslip</button>
                <button className="btn" onClick={() => setPayEdit(centsToInput(plan.pay))}>
                  {plan.payIsActual ? 'Change pay' : 'Type pay'}
                </button>
                <input ref={slipRef} type="file" accept="application/pdf" hidden
                  onChange={(e) => e.target.files?.[0] && uploadPayslip(e.target.files[0])} />
              </>
            ) : (
              <>
                <button className="btn primary" onClick={savePay}>Save pay</button>
                <button className="btn" onClick={() => setPayEdit(null)}>Cancel</button>
              </>
            )}
            <a className="btn" href="#/deposits" style={{ textDecoration: 'none', color: 'inherit' }}>Edit payday split</a>
          </div>
          {slipMsg && <p className={`small ${slipMsg.ok ? '' : 'error'}`} role="status">{slipMsg.text}</p>}

          {!avg && known && (
            <BalanceBox
              auto={autoHere}
              leftover={plan.leftover} payAccountName={payAccountName}
              needsBalance={needsBalance} shortAccounts={shortAccounts}
              adjustments={adjustments.map((a) => ({
                id: a.account.id, name: a.account.name, color: a.account.color, from: a.usual!, to: a.funded,
                reason: budget.autoBalanced?.[period.start]?.[a.account.id]?.reason
                  ?? (balanced?.periodStart === period.start ? balanced.result.changes.find((c) => c.accountId === a.account.id)?.reason : undefined),
              }))}
              modeChanges={balanced?.periodStart === period.start ? balanced.result.toSteady : []}
              notSpare={balanced?.periodStart === period.start ? balanced.result.notSpare : []}
              canReset={adjustments.length > 0 || hasModeChanges}
              onBalance={balanceThisPay} onReset={resetToDefaults}
              passedNote={paydayPassed && adjustments.length > 0
                ? `This pay was already split on ${fmtShort(period.start)}, so make these as transfers now, before ${fmtShort(plan.dues.find((d) => d.date >= today)?.date ?? period.end)}: move the money from the accounts being trimmed (or from what's left in ${payAccountName}) to the ones being topped up.`
                : undefined}
              optimise={undoHere || canOptimise ? {
                label: undoHere ? `Leftover put to work (${undoHere.label}).` : undefined,
                onUndo: undoHere ? undoOptimise : undefined,
                onOpen: canOptimise ? () => setOptimiseOpen(true) : undefined,
              } : undefined}
              debt={{ ratio: debtRatio, paid: debtPaid, guide: DEBT_RATIO_GUIDE }}
            />
          )}
        </div>

        {/* Sits at the top instead of stretching to the height of the card beside it. */}
        <div className="card" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', alignSelf: 'start', gap: 24 }}>
          <h2 className="h2" style={{ flex: '1 1 100%' }}>Where this pay goes</h2>
          <Donut slices={slices} size={170}>
            <span className="small muted">Budgeted</span>
            <b style={{ fontSize: 19 }}>{cash(plan.totalSplit, { whole: true })}</b>
          </Donut>
          <div style={{ flex: '1 1 220px', minWidth: 0, display: 'flex' }}>
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
              <> That's unless it's already in {shorts.length === 1 ? 'the account' : 'those accounts'}: <a href="#/accounts" style={{ color: 'inherit', fontWeight: 600 }}>enter the balance in Accounts</a> to check.</>
            )}
          </span>
        </div>
      )}

      {!avg && notes.length > 0 && (
        <details className="card">
          <summary style={{ cursor: 'pointer', fontWeight: 600, minHeight: 32 }}>What's different this pay ({notes.length})</summary>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
            {notes.map((x) => (
              <div key={x.a.account.id} className="small">
                <span className="row" style={{ gap: 8 }}>
                  <span className="dot" style={{ background: x.a.account.color }} />
                  <span>
                    <b>{x.a.account.name}</b>: {cash(x.a.funded)} this pay
                    {Math.abs(x.extra) > 2000 ? `, usually about ${cash(x.usual, { whole: true })} (${x.extra > 0 ? '+' : '−'}${cash(Math.abs(x.extra), { whole: true })})` : ''}
                  </span>
                </span>
                {x.why.map((w) => <span key={w} className="muted" style={{ display: 'block', paddingLeft: 18 }}>{w}</span>)}
              </div>
            ))}
          </div>
        </details>
      )}

      <section style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="between">
          <h2 className="h2">Payday split</h2>
          <a href="#/deposits" className="small" style={{ fontWeight: 600, textDecoration: 'none' }}>Edit accounts</a>
        </div>

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
            // "5 × $275" when every cost repeats the same number of times (e.g. weekly food + gas), else a count.
            const sameCount = a.breakdown.length > 0 && a.breakdown.every((x) => x.count === a.breakdown[0].count);
            const times = sameCount && a.breakdown[0].count > 1
              ? `${a.breakdown[0].count} × ${cash(a.breakdown.reduce((s, x) => s + x.item.amount, 0))}`
              : `${a.dues.length} payment${a.dues.length === 1 ? '' : 's'} due`;
            const detail = auto
              ? (longRun ? (steadyMode ? 'Steady' : 'Exact · average')
                : !steadyMode && topsUp(budget, a.account.id)
                  ? (a.funded < a.need ? `Exact · ${cash(a.need, { whole: true })} of bills − ${cash(a.need - a.funded, { whole: true })} already there` : `Exact · ${a.dues.length} bills, nothing left over`)
                  : `${steadyMode ? 'Steady' : 'Exact'} · ${times}`)
              : isPay
              ? (known ? 'Pay lands here · what’s left' : 'Pay lands here · shows once pay is in')
              : a.diff === null
                ? (a.account.kind === 'external' ? 'Sent on payday' : 'No costs set')
                : longRun
                  ? `${cash(need)} needed on average`
                  : sameCount && a.breakdown[0].item.frequency !== 'monthly'
                    ? times
                    : `${a.dues.length} costs due · ${cash(a.need)}`;
            return (
              <div key={a.account.id} className="acc-card" style={{ background: `${a.account.color}22` }}>
              <a className="acc-link" href={cardHref(a.account.id)}>
                <div className="between" style={{ flexWrap: 'nowrap' }}>
                  <span className="acc-icon" style={{ background: a.account.color }}>
                    <Icon name={a.account.kind === 'external' ? 'send' : isPay ? 'wallet' : 'bank'} />
                  </span>
                  {diff !== null && diff !== 0 && (
                    <span className={`pill ${diff < 0 ? 'bad' : 'good'}`}>{diff < 0 ? `${cash(-diff, { whole: Math.abs(diff) >= 10000 })} short` : `+${cash(diff, { whole: diff >= 10000 })} spare`}</span>
                  )}
                  {diff === 0 && <span className="pill good">Exactly right</span>}
                  {ends !== undefined && (
                    <span className={`pill ${ends < 0 ? 'bad' : 'good'}`} title="Estimated balance at the end of this pay period">
                      {ends < 0 ? `${cash(-ends, { whole: true })} short` : `Ends ${cash(ends, { whole: true })}`}
                    </span>
                  )}
                </div>
                <p className="acc-name">{a.account.name}</p>
                <p className={`amt ${funded < 0 && (known || !isPay) ? 'neg' : ''}`}>{isPay && !known ? '—' : cash(funded)}{split && !(isPay && !known) && <small className="muted" style={{ fontSize: 13, fontWeight: 500 }}> /{mode === 'week' ? 'wk' : 'fn'}</small>}</p>
                <p className="small muted">{a.usual !== undefined && a.usual !== a.funded ? `Adjusted this pay · usually ${cash(a.usual)}` : detail}</p>
                {(() => {
                  // The budget's first pay starts from what the pay before it left in the account (or left short).
                  if (avg || isPay || period.start !== firstBudgetPay(budget, today).start) return null;
                  const carry = leftoverBeforeBudget(budget, a.account.id);
                  if (!carry || !(budget.split.find((l) => l.accountId === a.account.id)?.mode === 'smooth' || topsUp(budget, a.account.id))) return null;
                  return <p className={`small ${carry < 0 ? 'neg' : 'pos'}`}>{carry < 0 ? `Includes ${cash(-carry, { whole: true })} the ${monthName(shiftPeriod(period, -1, budget.settings).start)} pay left short` : `${cash(carry, { whole: true })} left from ${monthName(shiftPeriod(period, -1, budget.settings).start)} counted`}</p>;
                })()}
              </a>
              {(() => {
                // Each cost this pay (e.g. food, car gas, scooter gas, or every bill in Misc bills), in a list you
                // can open and close. Same account and deposit; this only shows what its costs are.
                if (longRun || isPay) return null;
                const byName = new Map<string, { name: string; amount: Cents; dates: string[] }>();
                for (const d of a.dues) {
                  const name = d.item.name;
                  const r = byName.get(name) ?? { name, amount: 0, dates: [] };
                  r.amount += d.item.amount; r.dates.push(d.date);
                  byName.set(name, r);
                }
                const rows = [...byName.values()];
                if (rows.length < 2) return null;
                return (
                  <details className="cost-split" open={openCosts.includes(a.account.id)}
                    onToggle={(e) => toggleCosts(a.account.id, (e.currentTarget as HTMLDetailsElement).open)}>
                    <summary>{rows.length} costs this pay{split ? `, per ${mode}` : ''}</summary>
                    <div className="cost-rows">
                      {rows.map((r) => {
                        const each = r.amount / r.dates.length;
                        const same = r.dates.length > 1 && Number.isInteger(each);
                        return (
                          <span key={r.name} className="cost-row">
                            <span style={{ minWidth: 0 }}>
                              <span className="cost-name">{r.name}</span>
                              {/* How often / when, on its own line so names and amounts line up */}
                              <span className="cost-meta muted">
                                {same ? `${r.dates.length} × ${cash(each, { whole: each % 100 === 0 })}` : r.dates.length === 1 ? fmtShort(r.dates[0]) : `${r.dates.length} payments`}
                                {/* Week / Fortnight: say what the whole pay is, since the amount on the right is per week */}
                                {split ? `${same ? ' =' : ' ·'} ${cash(r.amount)} this pay` : ''}
                              </span>
                            </span>
                            <b className="num">{cash(v(r.amount))}{split && <small className="muted" style={{ fontWeight: 500 }}> /{mode === 'week' ? 'wk' : 'fn'}</small>}</b>
                          </span>
                        );
                      })}
                    </div>
                  </details>
                );
              })()}
              </div>
            );
          })}
        </div>
      </section>

      {!avg && <WeeksView budget={budget} period={period} plan={plan} />}

      {!avg && (
        <section className="card">
          <div className="between" style={{ marginBottom: 8 }}>
            <h2 className="h2">{isCurrent ? 'Coming up before next pay' : 'Due this period'}</h2>
            <span className="small muted">{upcoming.length} payments</span>
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
                    <span className="dot" style={{ background: acc?.color }} />
                    <span style={{ flex: 1, minWidth: 0 }}>
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
      )}
      {optimiseOpen && <OptimiseModal period={period} leftover={plan.leftover} onClose={() => setOptimiseOpen(false)} onApplied={(u) => setOptUndo(u)} />}
    </>
  );
}

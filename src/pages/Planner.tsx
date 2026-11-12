import { useMemo, useRef, useState } from 'react';
import { readPayslipPdf } from '../lib/payslip';
import { applyBalance, autoBalanceOn, autoPays, balancePay, DEBT_RATIO_GUIDE, restoreOverrides, stopAutoBalance, type BalanceResult } from '../lib/rebalance';
import { BalanceBox } from '../components/BalanceBox';
import { accountMode, leftoverBeforeBudget, topsUp } from '../lib/balances';
import { Donut, Legend } from '../components/Donut';
import { Icon } from '../components/Icon';
import { WeeksView } from '../components/WeeksView';
import { PayNav, useViewPeriod } from '../lib/period';
import { clearOptimiseUndo, OptimiseModal, readOptimiseUndo, type OptimiseUndo } from '../components/OptimiseModal';
import { undoAllocation } from '../lib/allocate';
import { applyPayrollDeduction } from '../lib/debts';
import { fmtShort, monthName, todayISO } from '../lib/dates';
import {
  averageSplit, convert, firstBudgetPay, isAuto, periodContaining, planFor, plannedAverage, shiftPeriod, type View,
} from '../lib/engine';
import { centsToInput, money, moneyParts, parseMoney } from '../lib/money';
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
  const autoOn = autoBalanceOn(budget);
  const autoHere = autoOn && autoPays(budget, today).some((p) => p.start === period.start);
  const hasModeChanges = (() => { try { return !!JSON.parse(localStorage.getItem(MODES_KEY) ?? '{}')[period.start]; } catch { return false; } })();
  function toggleAuto(on: boolean) {
    update((b) => { if (on) b.settings.autoBalance = true; else stopAutoBalance(b); return b; });
    setBalanced(null);
  }
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
      const p = periodContaining(slip.payDay, budget.settings);
      let loan = false;
      update((b) => {
        b.payActuals[p.start] = slip.net;
        b.payslips = { ...(b.payslips ?? {}), [p.start]: slip };
        // The student loan comes out before pay: count the payslip's deduction against the loan.
        if (slip.studentLoan) loan = !!applyPayrollDeduction(b, p.start, slip.studentLoan);
        return b;
      });
      const diff = slip.net - budget.settings.expectedPay;
      setSlipMsg({
        ok: true,
        text: `${monthName(p.start)} pay recorded: ${money(slip.net)}` +
          (diff === 0 ? ', exactly as expected.' : `, ${money(Math.abs(diff))} ${diff > 0 ? 'more' : 'less'} than expected.`) +
          (loan && slip.studentLoan ? ` Student loan: ${money(slip.studentLoan)} taken off what you owe.` : ''),
      });
      setOffset(offset + periodsBetween(period.start, p.start));
    } catch {
      setSlipMsg({ ok: false, text: 'That file couldn’t be read as a PDF.' });
    } finally {
      if (slipRef.current) slipRef.current.value = '';
    }
  }

  function periodsBetween(from: string, to: string): number {
    let n = 0;
    let p = period;
    const dir = to > from ? 1 : -1;
    while (p.start !== to && Math.abs(n) < 240) { p = shiftPeriod(p, dir, budget.settings); n += dir; }
    return n;
  }

  return (
    <>
      <header className="between">
        <PayNav />
        <div className="seg" role="group" aria-label="Show amounts as">
          {MODES.map((m) => (
            <button key={m.v} aria-pressed={mode === m.v} onClick={() => setMode(m.v)}>{m.label}</button>
          ))}
        </div>
      </header>

      <section className="grid-2">
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {known ? (
            <div>
              <p className="small muted">{split
                ? `Left after plan, per ${mode} · this pay's ${period.days} days are ${(period.days / spanDays).toFixed(1)} ${mode}s`
                : mode === 'month' ? 'Left after plan, per month (average of the next 12 pays)'
                : mode === 'year' ? 'Left after plan over the next 12 pays'
                : 'Left after your plan'}</p>
              <p className={`big ${leftover < 0 ? 'neg' : ''}`} style={{ marginTop: 6 }}>
                {parts.main}<small>{parts.cents}</small>
              </p>
              <p className="small muted" style={{ marginTop: 10 }}>
                {plan.leftover < 0
                  ? `You've budgeted ${money(-plan.leftover)} more than this pay.`
                  : `Stays in ${payAccountName} for spending.`}
              </p>
              {!avg && plan.leftover < 0 && (
                <div className="small" style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <b>Why</b>
                  {drivers.map((x) => (
                    <span key={x.a.account.id} className="row" style={{ gap: 8 }}>
                      <span className="dot" style={{ background: x.a.account.color }} />
                      <span>{x.a.account.name}: {money(x.a.funded)} this pay, usually about {money(x.usual, { whole: true })} (+{money(x.extra, { whole: true })})</span>
                    </span>
                  ))}
                  {usualTotal > plan.pay && (
                    <span className="muted">Even in a normal pay your budget is {money(usualTotal - plan.pay, { whole: true })} more than your pay.</span>
                  )}
                  {drivers.length === 0 && usualTotal <= plan.pay && <span className="muted">A few small extras this pay add up.</span>}
                </div>
              )}
              {estimated && (
                <p className="small" style={{ marginTop: 8, display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span className="pill" style={{ background: 'var(--soft)', color: 'var(--muted)' }}>Estimate</span>
                  <span className="muted">
                    Using {monthName(plan.payEstimateFrom!)}'s pay of {money(plan.pay)}.{' '}
                    {paydayPassed ? 'Payday has passed: upload the payslip to make it exact.' : `Upload the payslip when it arrives on ${fmtShort(period.start)}.`}
                  </span>
                </p>
              )}
            </div>
          ) : (
            <div>
              <p className="small muted">Total budgeted</p>
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
                <b className={known ? '' : 'muted'}>{known ? money(v(plan.pay)) : 'Not in yet'}</b>
              ) : (
                <input aria-label="Actual pay" inputMode="decimal" autoFocus value={payEdit} onChange={(e) => setPayEdit(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && savePay()}
                  style={{ marginTop: 4, width: '100%', minHeight: 36, borderRadius: 8, border: '1px solid var(--line)', padding: '0 8px', background: 'var(--card)' }} />
              )}
            </div>
            <div className="stat"><span className="small muted">Total budgeted</span><b>{money(totalBudgeted)}</b></div>
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
              auto={autoHere} autoOn={autoOn} onToggleAuto={toggleAuto}
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

        <div className="card" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 24 }}>
          <Donut slices={slices} size={190}>
            <span className="small muted">Budgeted</span>
            <b style={{ fontSize: 19 }}>{money(plan.totalSplit, { whole: true })}</b>
          </Donut>
          <div style={{ flex: '1 1 200px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <h2 className="h2">Where this pay goes</h2>
            <Legend slices={slices} />
          </div>
        </div>
      </section>

      {!avg && shorts.length > 0 && (
        <div className="alert" role="status">
          <Icon name="alert" />
          <span>
            {shorts.map((s) => `${s.account.name} needs ${money(-(s.diff ?? 0))} more`).join(' · ')}
            {' '}this {period.days}-day period.
            {shorts.some((s) => s.account.kind === 'bank' && !budget.balances?.[s.account.id]) && (
              <> That's unless it's already in {shorts.length === 1 ? 'the account' : 'those accounts'}: <a href="#/accounts" style={{ color: 'inherit', fontWeight: 600 }}>enter the balance in Accounts</a> to check.</>
            )}
          </span>
        </div>
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
              ? `${a.breakdown[0].count} × ${money(a.breakdown.reduce((s, x) => s + x.item.amount, 0))}`
              : `${a.dues.length} payment${a.dues.length === 1 ? '' : 's'} due`;
            const detail = auto
              ? (longRun ? (steadyMode ? 'Steady' : 'Exact · average')
                : !steadyMode && topsUp(budget, a.account.id)
                  ? (a.funded < a.need ? `Exact · ${money(a.need, { whole: true })} of bills − ${money(a.need - a.funded, { whole: true })} already there` : `Exact · ${a.dues.length} bills, nothing left over`)
                  : `${steadyMode ? 'Steady' : 'Exact'} · ${times}`)
              : isPay
              ? (known ? 'Pay lands here · what’s left' : 'Pay lands here · shows once pay is in')
              : a.diff === null
                ? (a.account.kind === 'external' ? 'Sent on payday' : 'No costs set')
                : longRun
                  ? `${money(need)} needed on average`
                  : sameCount && a.breakdown[0].item.frequency !== 'monthly'
                    ? times
                    : `${a.dues.length} costs due · ${money(a.need)}`;
            return (
              <div key={a.account.id} className="acc-card" style={{ background: `${a.account.color}22` }}>
              <a className="acc-link" href={cardHref(a.account.id)}>
                <div className="between" style={{ flexWrap: 'nowrap' }}>
                  <span className="acc-icon" style={{ background: a.account.color }}>
                    <Icon name={a.account.kind === 'external' ? 'send' : isPay ? 'wallet' : 'bank'} />
                  </span>
                  {diff !== null && diff !== 0 && (
                    <span className={`pill ${diff < 0 ? 'bad' : 'good'}`}>{diff < 0 ? `${money(-diff, { whole: Math.abs(diff) >= 10000 })} short` : `+${money(diff, { whole: diff >= 10000 })} spare`}</span>
                  )}
                  {diff === 0 && <span className="pill good">Exactly right</span>}
                  {ends !== undefined && (
                    <span className={`pill ${ends < 0 ? 'bad' : 'good'}`} title="Estimated balance at the end of this pay period">
                      {ends < 0 ? `${money(-ends, { whole: true })} short` : `Ends ${money(ends, { whole: true })}`}
                    </span>
                  )}
                </div>
                <p className="small" style={{ marginTop: 8 }}>{a.account.name}</p>
                <p className={`amt ${funded < 0 && (known || !isPay) ? 'neg' : ''}`}>{isPay && !known ? '—' : money(funded)}{split && !(isPay && !known) && <small className="muted" style={{ fontSize: 13, fontWeight: 500 }}> /{mode === 'week' ? 'wk' : 'fn'}</small>}</p>
                <p className="small muted">{a.usual !== undefined && a.usual !== a.funded ? `Adjusted this pay · usually ${money(a.usual)}` : detail}</p>
                {(() => {
                  // The budget's first pay starts from what the pay before it left in the account (or left short).
                  if (avg || isPay || period.start !== firstBudgetPay(budget, today).start) return null;
                  const carry = leftoverBeforeBudget(budget, a.account.id);
                  if (!carry || !(budget.split.find((l) => l.accountId === a.account.id)?.mode === 'smooth' || topsUp(budget, a.account.id))) return null;
                  return <p className={`small ${carry < 0 ? 'neg' : 'pos'}`}>{carry < 0 ? `Includes ${money(-carry, { whole: true })} the ${monthName(shiftPeriod(period, -1, budget.settings).start)} pay left short` : `${money(carry, { whole: true })} left from ${monthName(shiftPeriod(period, -1, budget.settings).start)} counted`}</p>;
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
                          <span key={r.name} className="between small" style={{ flexWrap: 'nowrap', gap: 8, alignItems: 'baseline' }}>
                            <span style={{ minWidth: 0 }}>
                              {r.name}{' '}
                              <span className="muted">
                                {same ? `${r.dates.length} × ${money(each, { whole: each % 100 === 0 })}` : r.dates.length === 1 ? fmtShort(r.dates[0]) : `${r.dates.length} payments`}
                                {/* Week / Fortnight: say what the whole pay is, since the amount on the right is per week */}
                                {split ? `${same ? ' =' : ' ·'} ${money(r.amount, { whole: r.amount % 100 === 0 })} this pay` : ''}
                              </span>
                            </span>
                            <b className="num">{money(v(r.amount), { whole: !split && r.amount % 100 === 0 })}{split && <small className="muted" style={{ fontWeight: 500 }}> /{mode === 'week' ? 'wk' : 'fn'}</small>}</b>
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
          {dues.map((d, i) => {
            const acc = budget.accounts.find((a) => a.id === d.item.accountId);
            return (
              <div className="list-row" key={`${d.item.id}-${d.date}-${i}`}>
                <span className="small muted" style={{ width: 56, flex: '0 0 56px' }}>{fmtShort(d.date)}</span>
                <span className="dot" style={{ background: acc?.color }} />
                <span style={{ flex: 1, minWidth: 0 }}>{d.item.name}<span className="small muted"> · {acc?.name}</span></span>
                <b>{money(d.item.amount)}</b>
              </div>
            );
          })}
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

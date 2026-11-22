import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { Icon } from '../ui/Icon';
import { fmtShort, monthName, todayISO } from '../core/dates';
import { budgetPeriod, shiftPeriod, upcomingPayPeriod, type Period } from '../engine/periods';
import { type View } from '../engine/frequency';
import { useBudget } from './store';

/** The pay period being viewed — shared by Planner, Debts, Savings and Deposits. */
/** How amounts are shown: this pay, or as a week, fortnight, month (average) or year. */
export type ViewMode = 'period' | View;
const MODES: { v: ViewMode; label: string }[] = [
  { v: 'period', label: 'This period' },
  { v: 'week', label: 'Week' },
  { v: 'fortnight', label: 'Fortnight' },
  { v: 'month', label: 'Month avg' },
  { v: 'year', label: 'Year' },
];
const MODE_KEY = 'paydays.viewMode';

interface PeriodState {
  /** Shared by the Planner and Insights, so both show the same view. */
  mode: ViewMode;
  setMode: (m: ViewMode) => void;
  offset: number;
  setOffset: (n: number) => void;
  period: Period;
  firstPeriod: Period;
  /** The earliest pay you can go back to (the pay you're in, once the budget has started). */
  earliest: Period;
}

const Ctx = createContext<PeriodState | null>(null);
const KEY = 'paydays.viewOffset';

export function PeriodProvider({ children }: { children: ReactNode }) {
  const { budget } = useBudget();
  const today = todayISO();
  // Opens on the next pay to come (planning ahead); you can go back to the pay you're in, not before.
  const firstPeriod = useMemo(() => upcomingPayPeriod(budget, today), [budget, today]);
  const earliest = useMemo(() => budgetPeriod(budget, today), [budget, today]);
  const minOffset = earliest.start < firstPeriod.start ? -1 : 0;
  const [offset, setOffsetState] = useState(() => {
    try { return Math.max(minOffset, Number(sessionStorage.getItem(KEY) ?? 0) || 0); } catch { return 0; }
  });
  const setOffset = (n: number) => {
    const v = Math.max(minOffset, n);
    setOffsetState(v);
    try { sessionStorage.setItem(KEY, String(v)); } catch { /* ignore */ }
  };
  const [mode, setModeState] = useState<ViewMode>(() => {
    try { const m = sessionStorage.getItem(MODE_KEY); return MODES.some((x) => x.v === m) ? (m as ViewMode) : 'period'; } catch { return 'period'; }
  });
  const setMode = (m: ViewMode) => { setModeState(m); try { sessionStorage.setItem(MODE_KEY, m); } catch { /* ignore */ } };
  const period = useMemo(() => shiftPeriod(firstPeriod, Math.max(minOffset, offset), budget.settings), [firstPeriod, offset, minOffset, budget.settings]);
  return <Ctx.Provider value={{ mode, setMode, offset: Math.max(minOffset, offset), setOffset, period, firstPeriod, earliest }}>{children}</Ctx.Provider>;
}

export function useViewPeriod(): PeriodState {
  const s = useContext(Ctx);
  if (!s) throw new Error('useViewPeriod must be inside PeriodProvider');
  return s;
}

/** This period · Week · Fortnight · Month avg · Year */
export function ViewModes() {
  const { mode, setMode } = useViewPeriod();
  return (
    <div className="seg seg-modes" role="group" aria-label="Show amounts as">
      {MODES.map((m) => (
        <button key={m.v} aria-pressed={mode === m.v} onClick={() => setMode(m.v)}>{m.label}</button>
      ))}
    </div>
  );
}

/**
 * ‹ November pay › — moves every page that follows the selected pay.
 * Not `compact`: the page's whole header (title, then `children` such as the page's buttons or view
 * switch, then the arrows). The arrows are always last, at the header's right edge, on every page that
 * has them (DayPicker draws the same header), so they never move between pages or as you step pays.
 * `compact`: a small control inside a pop-up (Deposits).
 */
export function PayNav({ title, compact, children }: { title?: string; compact?: boolean; children?: ReactNode }) {
  const { offset, setOffset, period, earliest } = useViewPeriod();
  // "Next pay" is always there (dimmed while you're on it), like a calendar's Today, so nothing moves.
  const back = <button className="btn small ghost" disabled={offset === 0} onClick={() => setOffset(0)}>Next pay</button>;
  const arrows = (
    <>
      <button className="icon-btn plain" aria-label="Previous pay period" disabled={period.start <= earliest.start} onClick={() => setOffset(offset - 1)}><Icon name="left" /></button>
      <button className="icon-btn plain" aria-label="Next pay period" onClick={() => setOffset(offset + 1)}><Icon name="right" /></button>
    </>
  );
  if (compact) {
    return (
      <div className="pay-nav compact">
        <div className="grow" style={{ minWidth: '10.5rem' }}>
          <b className="block">{monthName(period.start)} pay</b>
          <span className="xs muted block">{fmtShort(period.start)} – {fmtShort(period.end)} · {period.days} days</span>
        </div>
        <div className="pay-nav-steps">{back}{arrows}</div>
      </div>
    );
  }
  return (
    <header className="page-head">
      <div className="page-title">
        <h1 className="h1 clip">{title ?? `${monthName(period.start)} pay`}</h1>
        <p className="small muted clip">
          {title ? `${monthName(period.start)} pay · ` : ''}{fmtShort(period.start)} – {fmtShort(period.end)}{title ? '' : ` · ${period.days} days`}
        </p>
      </div>
      {children}
      <div className="pay-nav-steps">{back}{arrows}</div>
    </header>
  );
}

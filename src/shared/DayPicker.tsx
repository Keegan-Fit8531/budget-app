import { useState, type ReactNode } from 'react';
import { Collapse } from '../ui/components';
import { addDays, fmtDay, fmtShort, monthName, todayISO } from '../core/dates';
import { periodContaining, shiftPeriod, type Period } from '../engine/periods';
import { useBudget } from '../state/store';
import { Icon } from '../ui/Icon';

export interface DayView {
  /** Pays after this one (0 = the pay you're in now). */
  offset: number;
  view: Period;
  /** The day being looked at (today by default). */
  day: string;
  today: string;
  /** True when looking at today: the live view, from the amounts you've entered. */
  isToday: boolean;
  /** True when a day was picked (rather than the pay's default day). */
  picked: boolean;
  dayIdx: number;
  goPay: (offset: number) => void;
  setDay: (day: string) => void;
}

/**
 * A pay and a day in it to look at, starting from today in the pay you're in now. Remembered for
 * the session per page (e.g. Accounts and Debts each keep their own). Another pay opens on its
 * payday, or with `endOfPay` on its last day (Debts: what's owed once that pay's payments are made).
 */
export function useDayView(key: string, opts: { endOfPay?: boolean } = {}): DayView {
  const { budget } = useBudget();
  const today = todayISO();
  const current = periodContaining(today, budget.settings);
  const read = () => { try { return JSON.parse(sessionStorage.getItem(key) ?? 'null') as { offset: number; day: string | null } | null; } catch { return null; } };
  const [state, setState] = useState<{ offset: number; day: string | null }>(() => read() ?? { offset: 0, day: null });
  const save = (v: { offset: number; day: string | null }) => { setState(v); try { sessionStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ } };
  const offset = Math.max(0, Math.min(24, state.offset));
  const view = shiftPeriod(current, offset, budget.settings);
  const inView = (d: string) => d >= view.start && d <= view.end;
  const picked = !!state.day && inView(state.day);
  const day = picked ? state.day! : inView(today) ? today : opts.endOfPay ? view.end : view.start;
  return {
    offset, view, day, today, isToday: day === today, picked,
    dayIdx: Math.round((Date.parse(day) - Date.parse(view.start)) / 86400000),
    goPay: (n) => save({ offset: Math.max(0, Math.min(24, n)), day: null }),
    setDay: (d) => save({ offset, day: d }),
  };
}

/**
 * The top of a page that looks at a pay and a day in it, the same way the Planner does: the page's
 * title with the pay and day under it, and ‹ › to step pays beside it. A different day is picked
 * now and then, so its slider sits behind the calendar button (and stays open while one is chosen).
 */
export function DayPicker({ dv, title, children }: { dv: DayView; title: string; children?: ReactNode }) {
  const { offset, view, day, today, dayIdx, picked, goPay, setDay } = dv;
  const setIdx = (i: number) => setDay(addDays(view.start, Math.max(0, Math.min(view.days - 1, i))));
  const moved = offset > 0 || day !== today;
  const [picking, setPicking] = useState(false);
  // The day slider opens only when asked for (or a day has been picked), not on every change of pay,
  // and the buttons beside the title are always there, so nothing shifts as you step through pays.
  const open = picking || picked;
  return (
    <>
      <header className="page-head">
        <div className="page-title">
          <h1 className="h1 clip">{title}</h1>
          {/* One short line: the pay, and the day looked at (or how far into the pay today is). Cards say "Projected" or "Estimated" themselves. */}
          <p className="small muted clip">
            {monthName(view.start)} pay · {day === today ? `day ${dayIdx + 1} of ${view.days}` : fmtShort(day)}
          </p>
        </div>
        {children}
        {/* Same place and order as PayNav's: Today (dimmed while on today), then the calendar, then ‹ ›. */}
        <div className="pay-nav-steps">
          <button className="btn small ghost" disabled={!moved} onClick={() => { goPay(0); setPicking(false); }}>Today</button>
          <button className={`icon-btn plain has-tip${open ? ' on' : ''}`} data-tip="Look at another day" aria-label="Look at another day" aria-expanded={open}
            onClick={() => { if (open && picked) setDay(''); setPicking(!open); }}><Icon name="calendar" /></button>
          <button className="icon-btn plain" aria-label="Previous pay" disabled={offset === 0} onClick={() => goPay(offset - 1)}><Icon name="left" /></button>
          <button className="icon-btn plain" aria-label="Next pay" onClick={() => goPay(offset + 1)}><Icon name="right" /></button>
        </div>
      </header>
      <Collapse open={open}>
        <div className="card stack gap-4" style={{ padding: 'var(--s-3) var(--s-4)' }}>
          <div className="row nowrap gap-8">
            <button className="icon-btn plain" aria-label="Previous day" onClick={() => setIdx(dayIdx - 1)} disabled={dayIdx === 0}><Icon name="left" /></button>
            <input type="range" min={0} max={view.days - 1} value={dayIdx} onChange={(e) => setIdx(Number(e.target.value))}
              aria-label="Day in this pay" aria-valuetext={fmtDay(day)} className="grow" style={{ minHeight: 'var(--tap)' }} />
            <button className="icon-btn plain" aria-label="Next day" onClick={() => setIdx(dayIdx + 1)} disabled={dayIdx === view.days - 1}><Icon name="right" /></button>
          </div>
          <div className="between small">
            <span className="muted">{fmtDay(view.start)} – {fmtDay(view.end)}</span>
            <span className="row wrap gap-4">
              <button className="btn small ghost" onClick={() => setIdx(0)}>Payday</button>
              <button className="btn small ghost" onClick={() => setIdx(view.days - 1)}>Day before next pay</button>
            </span>
          </div>
        </div>
      </Collapse>
    </>
  );
}

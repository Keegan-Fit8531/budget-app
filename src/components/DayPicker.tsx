import { useState } from 'react';
import { addDays, fmtDay, fmtShort, monthName, todayISO } from '../lib/dates';
import { periodContaining, shiftPeriod, type Period } from '../lib/engine';
import { useBudget } from '../lib/store';
import { Icon } from './Icon';

export interface DayView {
  /** Pays after this one (0 = the pay you're in now). */
  offset: number;
  view: Period;
  /** The day being looked at (today by default). */
  day: string;
  today: string;
  /** True when looking at today: the live view, from the amounts you've entered. */
  isToday: boolean;
  dayIdx: number;
  goPay: (offset: number) => void;
  setDay: (day: string) => void;
}

/**
 * A pay and a day in it to look at, starting from today in the pay you're in now. Remembered for
 * the session per page (e.g. Accounts and Debts each keep their own).
 */
export function useDayView(key: string): DayView {
  const { budget } = useBudget();
  const today = todayISO();
  const current = periodContaining(today, budget.settings);
  const read = () => { try { return JSON.parse(sessionStorage.getItem(key) ?? 'null') as { offset: number; day: string | null } | null; } catch { return null; } };
  const [state, setState] = useState<{ offset: number; day: string | null }>(() => read() ?? { offset: 0, day: null });
  const save = (v: { offset: number; day: string | null }) => { setState(v); try { sessionStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ } };
  const offset = Math.max(0, Math.min(24, state.offset));
  const view = shiftPeriod(current, offset, budget.settings);
  const inView = (d: string) => d >= view.start && d <= view.end;
  const day = state.day && inView(state.day) ? state.day : inView(today) ? today : view.start;
  return {
    offset, view, day, today, isToday: day === today,
    dayIdx: Math.round((Date.parse(day) - Date.parse(view.start)) / 86400000),
    goPay: (n) => save({ offset: Math.max(0, Math.min(24, n)), day: null }),
    setDay: (d) => save({ offset, day: d }),
  };
}

/**
 * The pay and day being looked at, on one line: ‹ October pay · this pay ›, Fri 13 Nov · today.
 * Looking at a different day is something done now and then, so the slider for it sits behind
 * the calendar button (and stays open while a day other than today is chosen).
 */
export function DayPicker({ dv }: { dv: DayView }) {
  const { offset, view, day, today, dayIdx, goPay, setDay } = dv;
  const setIdx = (i: number) => setDay(addDays(view.start, Math.max(0, Math.min(view.days - 1, i))));
  const now = today >= view.start && today <= view.end;
  const moved = offset > 0 || day !== today;
  const [picking, setPicking] = useState(false);
  const open = picking || day !== today;
  return (
    <div className="card stack gap-8" style={{ padding: 'var(--s-3) var(--s-4)' }}>
      <div className="between nowrap">
        <div className="min0">
          <b className="block">{monthName(view.start)} pay{now ? ' · this pay' : offset === 1 ? ' · next pay' : ''}</b>
          <span className="small muted block">
            {day === today ? `Today, ${fmtShort(day)}` : `${fmtDay(day)} · ${day > today ? 'projected' : 'earlier'}`} · day {dayIdx + 1} of {view.days}
          </span>
        </div>
        <div className="row gap-4 day-steps" style={{ flex: '0 0 auto' }}>
          {moved && <button className="btn small ghost" onClick={() => { goPay(0); setPicking(false); }}>Today</button>}
          {/* While another day is chosen the slider stays open, and Today puts it away. */}
          {day === today && (
            <button className={`icon-btn plain has-tip${open ? ' on' : ''}`} data-tip="Look at another day" aria-label="Look at another day" aria-expanded={open}
              onClick={() => setPicking(!open)}><Icon name="calendar" /></button>
          )}
          <button className="icon-btn plain" aria-label="Previous pay" disabled={offset === 0} onClick={() => goPay(offset - 1)}><Icon name="left" /></button>
          <button className="icon-btn plain" aria-label="Next pay" onClick={() => goPay(offset + 1)}><Icon name="right" /></button>
        </div>
      </div>
      {open && (
        <div className="stack gap-4" style={{ borderTop: '1px solid var(--line)', paddingTop: 'var(--s-2)' }}>
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
      )}
    </div>
  );
}

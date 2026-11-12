import { useState } from 'react';
import { addDays, fmtDay, monthName, todayISO } from '../lib/dates';
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

/** ‹ November pay › plus a slider for the day in it. */
export function DayPicker({ dv }: { dv: DayView }) {
  const { offset, view, day, today, dayIdx, goPay, setDay } = dv;
  const setIdx = (i: number) => setDay(addDays(view.start, Math.max(0, Math.min(view.days - 1, i))));
  const now = today >= view.start && today <= view.end;
  return (
    <div className="card" style={{ padding: '10px 14px' }}>
      <div className="row" style={{ gap: 8 }}>
        {offset > 0
          ? <button className="icon-btn" aria-label="Previous pay" onClick={() => goPay(offset - 1)}><Icon name="left" /></button>
          : <span style={{ width: 44, flex: '0 0 44px' }} aria-hidden="true" />}
        <div style={{ minWidth: 0, flex: 1 }}>
          <b style={{ fontSize: 16 }}>{monthName(view.start)} pay{now ? ' · this pay' : offset === 1 ? ' · next pay' : ''}</b>
          <p className="small muted">{fmtDay(view.start)} – {fmtDay(view.end)} · {day === today ? 'today' : day > today ? 'projected' : 'earlier'}</p>
        </div>
        <button className="icon-btn" aria-label="Next pay" onClick={() => goPay(offset + 1)}><Icon name="right" /></button>
        {(offset > 0 || day !== today) && <button className="btn small ghost" onClick={() => goPay(0)}>Today</button>}
      </div>
      <div style={{ borderTop: '1px solid var(--line)', marginTop: 10, paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div className="between small">
          <b>{fmtDay(day)}{day === today ? ' · today' : ''}</b>
          <span className="muted">day {dayIdx + 1} of {view.days}</span>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
          <button className="icon-btn" aria-label="Previous day" onClick={() => setIdx(dayIdx - 1)} disabled={dayIdx === 0}><Icon name="left" /></button>
          <input type="range" min={0} max={view.days - 1} value={dayIdx} onChange={(e) => setIdx(Number(e.target.value))}
            aria-label="Day in this pay" style={{ flex: 1, accentColor: 'var(--brand)', minHeight: 44 }} />
          <button className="icon-btn" aria-label="Next day" onClick={() => setIdx(dayIdx + 1)} disabled={dayIdx === view.days - 1}><Icon name="right" /></button>
        </div>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <button className="btn small ghost" onClick={() => setIdx(0)}>Payday</button>
          {now && day !== today && <button className="btn small ghost" onClick={() => setDay(today)}>Today</button>}
          <button className="btn small ghost" onClick={() => setIdx(view.days - 1)}>Day before next pay</button>
        </div>
      </div>
    </div>
  );
}

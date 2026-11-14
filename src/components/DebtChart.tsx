import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Disclosure } from './ui';
import { tone } from '../lib/colors';
import { monthName, todayISO } from '../lib/dates';
import { debtPerPay, debtSchedules, historyOwed, owed, projectedOwed } from '../lib/debts';
import { periodContaining, shiftPeriod, type Period } from '../lib/engine';
import { cash } from '../lib/money';
import type { Budget, Debt } from '../lib/types';

interface Point {
  period: Period;
  label: string;
  /** Recorded balance (past and today). */
  actual?: number;
  /** Forecast from payment plans (today onwards). */
  forecast?: number;
  payment: number;
  isNow: boolean;
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(640);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function niceMax(v: number): number {
  if (v <= 0) return 100000; // $1,000
  const dollars = v / 100;
  const pow = 10 ** Math.floor(Math.log10(dollars));
  const step = [1, 2, 2.5, 5, 10].find((m) => m * pow * 4 >= dollars) ?? 10;
  return step * pow * 4 * 100;
}
const axisMoney = (c: number) => {
  const d = c / 100;
  return d >= 10000 ? `$${Math.round(d / 1000)}K` : `$${d.toLocaleString('en-NZ', { maximumFractionDigits: 0 })}`;
};

const RANGES = [{ n: 6, label: '6 months' }, { n: 12, label: '1 year' }, { n: 24, label: '2 years' }, { n: 36, label: '3 years' }];
const PAST = 6;

export function DebtChart({ budget }: { budget: Budget }) {
  const debts = budget.debts ?? [];
  const s = budget.settings;
  const today = todayISO();
  const [ahead, setAhead] = useState(12);
  const [sel, setSel] = useState('all');
  const [hover, setHover] = useState<number | null>(null);
  const [wrapRef, width] = useWidth<HTMLDivElement>();

  const chosen: Debt[] = sel === 'all' ? debts : debts.filter((d) => d.id === sel);
  const color = sel === 'all' ? 'var(--brand-2)' : tone(budget.accounts.find((a) => a.id === chosen[0]?.accountId)?.color ?? chosen[0]?.color);

  const points = useMemo<Point[]>(() => {
    const cur = periodContaining(today, s);
    // Show up to 6 past pays, but only back to the earliest recorded history.
    const earliest = chosen.flatMap((d) => d.history ?? []).map((h) => h.asOf).sort()[0];
    let back = 0;
    if (earliest) { let p = cur; while (back < PAST && p.start > earliest) { p = shiftPeriod(p, -1, s); back++; } }
    const pays = chosen.flatMap((d) => debtSchedules(d, s, debtPerPay(budget, d)).flatMap((x) => x.payments));
    const out: Point[] = [];
    let p = shiftPeriod(cur, -back, s);
    for (let i = 0; i <= back + ahead; i++) {
      const isNow = p.start === cur.start;
      const isPast = p.start < cur.start;
      const at = isNow ? today : p.end;
      const hist = chosen.map((d) => (isNow ? owed(d) : historyOwed(d, at)));
      const actual = isPast || isNow ? (hist.some((h) => h !== undefined) ? hist.reduce<number>((t, h) => t + (h ?? 0), 0) : undefined) : undefined;
      const forecast = isPast ? undefined : isNow ? chosen.reduce((t, d) => t + owed(d), 0) : chosen.reduce((t, d) => t + projectedOwed(d, s, p.end, debtPerPay(budget, d)), 0);
      out.push({
        period: p, isNow, actual, forecast,
        label: `${monthName(p.start).slice(0, 3)}${p.start.slice(5, 7) === '01' || i === 0 ? ` ${p.start.slice(2, 4)}` : ''}`,
        payment: isPast ? 0 : pays.filter((x) => x.date >= p.start && x.date <= p.end).reduce((t, x) => t + x.amount, 0),
      });
      p = shiftPeriod(p, 1, s);
    }
    return out;
  }, [chosen, ahead, s, today]);

  // Layout
  const padL = 52, padR = 12, topH = 190, barH = 90, gap = 34, axisH = 22;
  const innerW = Math.max(120, width - padL - padR);
  const step = innerW / Math.max(1, points.length - 1);
  const x = (i: number) => padL + (points.length === 1 ? innerW / 2 : i * step);
  const maxOwed = niceMax(Math.max(0, ...points.map((p) => Math.max(p.actual ?? 0, p.forecast ?? 0))));
  const yO = (v: number) => 12 + (1 - v / maxOwed) * (topH - 12);
  const maxPay = niceMax(Math.max(0, ...points.map((p) => p.payment)));
  const barTop = topH + gap;
  const yP = (v: number) => barTop + (1 - v / maxPay) * barH;
  const H = barTop + barH + axisH;
  const nowI = points.findIndex((p) => p.isNow);
  const barW = Math.min(24, Math.max(4, step * 0.55));
  const labelEvery = Math.ceil(points.length / Math.max(2, Math.floor(innerW / 46)));

  const pathOf = (key: 'actual' | 'forecast') => {
    let d = '';
    points.forEach((p, i) => { const v = p[key]; if (v === undefined) return; d += `${d ? 'L' : 'M'}${x(i).toFixed(1)},${yO(v).toFixed(1)}`; });
    return d;
  };
  const actualPath = pathOf('actual');
  const forecastPath = pathOf('forecast');
  const areaOf = (key: 'actual' | 'forecast') => {
    const idx = points.map((p, i) => (p[key] !== undefined ? i : -1)).filter((i) => i >= 0);
    if (idx.length < 2) return '';
    return `${pathOf(key)}L${x(idx[idx.length - 1]).toFixed(1)},${yO(0)}L${x(idx[0]).toFixed(1)},${yO(0)}Z`;
  };

  function onMove(e: PointerEvent<SVGSVGElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.round((e.clientX - r.left - padL) / step);
    setHover(Math.max(0, Math.min(points.length - 1, i)));
  }
  function onKey(e: KeyboardEvent<SVGSVGElement>) {
    if (e.key === 'ArrowRight') { setHover((h) => Math.min(points.length - 1, (h ?? nowI) + 1)); e.preventDefault(); }
    if (e.key === 'ArrowLeft') { setHover((h) => Math.max(0, (h ?? nowI) - 1)); e.preventDefault(); }
  }

  const h = hover !== null ? points[hover] : null;
  const paidOff = points.find((p, i) => i > nowI && p.forecast === 0 && (points[i - 1]?.forecast ?? 1) > 0);
  const summary = `${chosen.length === 1 ? chosen[0].name : 'All debts'}: ${cash(points[nowI]?.forecast ?? 0)} owed now` +
    (paidOff ? `, paid off by ${monthName(paidOff.period.start)} ${paidOff.period.start.slice(0, 4)}` : '') + '.';

  return (
    <section className="card stack gap-12">
      <div className="card-head">
        <h2 className="h2">Balance over time</h2>
        <span className="small muted">{summary}</span>
      </div>
      <div className="row wrap gap-8">
        <div className="seg" role="group" aria-label="Which debt">
          <button aria-pressed={sel === 'all'} onClick={() => setSel('all')}>All debts</button>
          {debts.map((d) => <button key={d.id} aria-pressed={sel === d.id} onClick={() => setSel(d.id)}>{d.name}</button>)}
        </div>
        <div className="seg" role="group" aria-label="How far ahead">
          {RANGES.map((r) => <button key={r.n} aria-pressed={ahead === r.n} onClick={() => setAhead(r.n)}>{r.label}</button>)}
        </div>
      </div>

      <div className="key" aria-hidden="true">
        <span><svg width="18" height="4"><line x1="0" y1="2" x2="18" y2="2" stroke={color} strokeWidth="2" strokeLinecap="round" /></svg>Owed (recorded)</span>
        <span><svg width="18" height="4"><line x1="0" y1="2" x2="18" y2="2" stroke={color} strokeWidth="2" strokeDasharray="4 3" strokeLinecap="round" /></svg>Owed (forecast)</span>
        <span><svg width="10" height="10"><rect width="10" height="10" rx="2" fill={color} opacity="0.55" /></svg>Payments each pay</span>
      </div>

      <div ref={wrapRef} style={{ position: 'relative', width: '100%' }}>
        <svg width={width} height={H} role="img" aria-label={`${summary} Use the left and right arrow keys to read each month.`}
          tabIndex={0} onPointerMove={onMove} onPointerLeave={() => setHover(null)} onKeyDown={onKey} onBlur={() => setHover(null)}
          style={{ display: 'block', touchAction: 'pan-y', outline: 'none' }}>
          {/* Grid + y ticks: balance */}
          {[0, 0.25, 0.5, 0.75, 1].map((t) => (
            <g key={`o${t}`}>
              <line x1={padL} x2={padL + innerW} y1={yO(maxOwed * t)} y2={yO(maxOwed * t)} stroke="var(--line)" strokeWidth="1" />
              <text x={padL - 8} y={yO(maxOwed * t) + 4} textAnchor="end" fontSize="11" fill="var(--muted)">{axisMoney(maxOwed * t)}</text>
            </g>
          ))}
          {/* Grid + y ticks: payments */}
          {[0, 0.5, 1].map((t) => (
            <g key={`p${t}`}>
              <line x1={padL} x2={padL + innerW} y1={yP(maxPay * t)} y2={yP(maxPay * t)} stroke="var(--line)" strokeWidth="1" />
              <text x={padL - 8} y={yP(maxPay * t) + 4} textAnchor="end" fontSize="11" fill="var(--muted)">{axisMoney(maxPay * t)}</text>
            </g>
          ))}
          <text x={padL} y={barTop - 10} fontSize="12" fill="var(--muted)">Payments each pay</text>

          {/* Today marker */}
          {nowI >= 0 && (
            <g>
              <line x1={x(nowI)} x2={x(nowI)} y1={6} y2={barTop + barH} stroke="var(--muted)" strokeWidth="1" opacity="0.6" />
              <text x={x(nowI) + 5} y={14} fontSize="11" fill="var(--muted)">Today</text>
            </g>
          )}

          {/* Balance areas + lines */}
          {areaOf('actual') && <path d={areaOf('actual')} fill={color} opacity="0.1" />}
          {areaOf('forecast') && <path d={areaOf('forecast')} fill={color} opacity="0.06" />}
          {actualPath && <path d={actualPath} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />}
          {forecastPath && <path d={forecastPath} fill="none" stroke={color} strokeWidth="2" strokeDasharray="5 4" strokeLinejoin="round" strokeLinecap="round" />}
          {points.map((p, i) => p.actual !== undefined && (i === nowI || hover === i) ? (
            <circle key={`a${i}`} cx={x(i)} cy={yO(p.actual)} r="4.5" fill={color} stroke="var(--card)" strokeWidth="2" />
          ) : null)}
          {hover !== null && hover !== nowI && points[hover].forecast !== undefined && (
            <circle cx={x(hover)} cy={yO(points[hover].forecast!)} r="4.5" fill="var(--card)" stroke={color} strokeWidth="2" />
          )}

          {/* Payment columns */}
          {points.map((p, i) => {
            if (p.payment <= 0) return null;
            const top = yP(p.payment), bh = barTop + barH - top, r = Math.min(4, bh);
            const x0 = x(i) - barW / 2;
            return (
              <path key={`b${i}`} opacity={hover === null || hover === i ? 0.7 : 0.35} fill={color}
                d={`M${x0},${barTop + barH}V${top + r}Q${x0},${top} ${x0 + r},${top}H${x0 + barW - r}Q${x0 + barW},${top} ${x0 + barW},${top + r}V${barTop + barH}Z`} />
            );
          })}

          {/* X labels */}
          {points.map((p, i) => (i === nowI || (i % labelEvery === 0 && (nowI < 0 || Math.abs(i - nowI) * step >= 40))) ? (
            <text key={`x${i}`} x={x(i)} y={H - 6} textAnchor="middle" fontSize="11" fill={i === nowI ? 'var(--ink)' : 'var(--muted)'}>{p.label}</text>
          ) : null)}

          {/* Crosshair */}
          {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={6} y2={barTop + barH} stroke="var(--ink)" strokeWidth="1" opacity="0.35" />}
        </svg>

        {h && (
          <div role="status" className="pop-card" style={{ position: 'absolute', top: 8, left: Math.min(Math.max(0, x(hover!) + 12), width - 190), width: 178 }}>
            <span className="muted">{monthName(h.period.start)} {h.period.start.slice(0, 4)} pay{h.isNow ? ' · now' : ''}</span>
            {h.actual !== undefined && <TipRow color={color} dashed={false} value={h.actual} label={h.isNow ? 'owed now' : 'owed (recorded)'} />}
            {h.forecast !== undefined && !h.isNow && <TipRow color={color} dashed value={h.forecast} label="owed (forecast)" />}
            {h.actual === undefined && h.forecast === undefined && <span className="muted">No balance recorded</span>}
            {h.period.start >= (points[nowI]?.period.start ?? '') && <TipRow color={color} bar value={h.payment} label="paid this pay" />}
          </div>
        )}
      </div>

      <Disclosure title="Show as a table">
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Pay</th>
                <th>Owed</th>
                <th>Payments</th>
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.period.start}>
                  <td>{monthName(p.period.start)} {p.period.start.slice(0, 4)}{p.isNow ? ' (now)' : ''}</td>
                  <td>{p.actual !== undefined ? cash(p.actual) : p.forecast !== undefined ? `${cash(p.forecast)} forecast` : '—'}</td>
                  <td>{p.payment ? cash(p.payment) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Disclosure>
    </section>
  );
}

function TipRow({ color, value, label, dashed, bar }: { color: string; value: number; label: string; dashed?: boolean; bar?: boolean }) {
  return (
    <span className="row gap-8">
      <svg width="14" height="10" aria-hidden="true">
        {bar ? <rect y="1" width="10" height="8" rx="2" fill={color} opacity="0.7" />
          : <line x1="0" y1="5" x2="14" y2="5" stroke={color} strokeWidth="2" strokeDasharray={dashed ? '4 3' : undefined} strokeLinecap="round" />}
      </svg>
      <b>{cash(value)}</b><span className="muted">{label}</span>
    </span>
  );
}


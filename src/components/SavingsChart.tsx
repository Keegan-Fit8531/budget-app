import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { monthName, todayISO } from '../lib/dates';
import { budgetPeriod, planFor, shiftPeriod, type Period } from '../lib/engine';
import { money } from '../lib/money';
import type { Budget, SavingsGoal } from '../lib/types';

interface Point { period: Period; label: string; balance: number; added: number }

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
  if (v <= 0) return 100000;
  const d = v / 100;
  const pow = 10 ** Math.floor(Math.log10(d));
  const step = [1, 2, 2.5, 5, 10].find((m) => m * pow * 4 >= d) ?? 10;
  return step * pow * 4 * 100;
}
const axisMoney = (c: number) => {
  const d = c / 100;
  return d >= 10000 ? `$${Math.round(d / 1000)}K` : `$${d.toLocaleString('en-NZ', { maximumFractionDigits: 0 })}`;
};

const RANGES = [{ n: 12, label: '1 year' }, { n: 24, label: '2 years' }, { n: 36, label: '3 years' }, { n: 60, label: '5 years' }];

/** Projected savings balance per pay (with what goes in each pay), against the goal's target and date. */
export function SavingsChart({ budget }: { budget: Budget }) {
  const goals = budget.savings ?? [];
  const today = todayISO();
  const [sel, setSel] = useState('all');
  const [pays, setPays] = useState(24);
  const [hover, setHover] = useState<number | null>(null);
  const [wrapRef, width] = useWidth<HTMLDivElement>();

  const chosen: SavingsGoal[] = sel === 'all' ? goals : goals.filter((g) => g.id === sel);
  const one = chosen.length === 1 ? chosen[0] : undefined;
  const color = one ? (budget.accounts.find((a) => a.id === one.accountId)?.color ?? '#22C55E') : '#22C55E';
  const target = one?.target ?? (chosen.every((g) => g.target) && chosen.length ? chosen.reduce((t, g) => t + (g.target ?? 0), 0) : undefined);
  const targetDate = one?.targetDate;

  const points = useMemo<Point[]>(() => {
    const out: Point[] = [];
    let bal = chosen.reduce((t, g) => t + g.balance, 0);
    let p = budgetPeriod(budget, today);
    // A single goal with a date (e.g. the wedding) only matters up to that date.
    const until = one?.targetDate;
    for (let i = 0; i < pays && (!until || p.start < until); i++) {
      const plan = planFor(budget, p);
      const gifts = chosen.reduce((t, g) => t + (g.gifts ?? []).filter((x) => !x.received && x.date >= p.start && x.date <= p.end).reduce((s, x) => s + x.amount, 0), 0);
      const added = gifts + chosen.reduce((t, g) => t + (plan.accounts.find((a) => a.account.id === g.accountId)?.funded ?? 0) + (g.otherPerPay ?? 0), 0);
      bal += added;
      out.push({ period: p, added, balance: bal, label: `${monthName(p.start).slice(0, 3)}${p.start.slice(5, 7) === '01' || i === 0 ? ` ${p.start.slice(2, 4)}` : ''}` });
      p = shiftPeriod(p, 1, budget.settings);
    }
    return out;
  }, [budget, chosen, pays, today, one?.targetDate]);

  const start = chosen.reduce((t, g) => t + g.balance, 0);
  const padL = 56, padR = 12, topH = 190, barH = 80, gap = 34, axisH = 22;
  const innerW = Math.max(120, width - padL - padR);
  const step = innerW / Math.max(1, points.length - 1);
  const x = (i: number) => padL + i * step;
  const maxBal = niceMax(Math.max(target ?? 0, ...points.map((p) => p.balance), start));
  const yB = (v: number) => 12 + (1 - v / maxBal) * (topH - 12);
  const maxAdd = niceMax(Math.max(0, ...points.map((p) => p.added)));
  const barTop = topH + gap;
  const yA = (v: number) => barTop + (1 - v / maxAdd) * barH;
  const H = barTop + barH + axisH;
  const barW = Math.min(24, Math.max(3, step * 0.55));
  const labelEvery = Math.ceil(points.length / Math.max(2, Math.floor(innerW / 46)));
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${yB(p.balance).toFixed(1)}`).join('');
  const area = points.length > 1 ? `${line}L${x(points.length - 1).toFixed(1)},${yB(0)}L${x(0).toFixed(1)},${yB(0)}Z` : '';
  const dateI = targetDate ? points.findIndex((p) => p.period.end >= targetDate) : -1;
  const reachedI = target !== undefined ? points.findIndex((p) => p.balance >= target) : -1;
  const last = points[points.length - 1];

  const summary = `${one ? one.name : 'All savings'}: ${money(start)} now, about ${money(last?.balance ?? start, { whole: true })} in ${RANGES.find((r) => r.n === pays)?.label}` +
    (target !== undefined ? (reachedI >= 0 ? `, reaching ${money(target, { whole: true })} by ${monthName(points[reachedI].period.start)} ${points[reachedI].period.start.slice(0, 4)}` : `, short of the ${money(target, { whole: true })} target`) : '') + '.';

  function onMove(e: PointerEvent<SVGSVGElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    setHover(Math.max(0, Math.min(points.length - 1, Math.round((e.clientX - r.left - padL) / step))));
  }
  function onKey(e: KeyboardEvent<SVGSVGElement>) {
    if (e.key === 'ArrowRight') { setHover((h) => Math.min(points.length - 1, (h ?? -1) + 1)); e.preventDefault(); }
    if (e.key === 'ArrowLeft') { setHover((h) => Math.max(0, (h ?? 1) - 1)); e.preventDefault(); }
  }
  const h = hover !== null ? points[hover] : null;

  if (!goals.length) return null;
  return (
    <section className="card" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="between">
        <h2 className="h2">Savings projection</h2>
        <span className="small muted">{summary}</span>
      </div>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div className="seg" role="group" aria-label="Which goal">
          <button aria-pressed={sel === 'all'} onClick={() => setSel('all')}>All goals</button>
          {goals.map((g) => <button key={g.id} aria-pressed={sel === g.id} onClick={() => setSel(g.id)}>{g.name}</button>)}
        </div>
        <div className="seg" role="group" aria-label="How far ahead">
          {RANGES.map((r) => <button key={r.n} aria-pressed={pays === r.n} onClick={() => setPays(r.n)}>{r.label}</button>)}
        </div>
      </div>

      <div ref={wrapRef} style={{ position: 'relative', width: '100%' }}>
        <svg width={width} height={H} role="img" aria-label={`${summary} Use the left and right arrow keys to read each pay.`}
          tabIndex={0} onPointerMove={onMove} onPointerLeave={() => setHover(null)} onKeyDown={onKey} onBlur={() => setHover(null)}
          style={{ display: 'block', touchAction: 'pan-y', outline: 'none' }}>
          {[0, 0.25, 0.5, 0.75, 1].map((t) => (
            <g key={`b${t}`}>
              <line x1={padL} x2={padL + innerW} y1={yB(maxBal * t)} y2={yB(maxBal * t)} stroke="var(--line)" strokeWidth="1" />
              <text x={padL - 8} y={yB(maxBal * t) + 4} textAnchor="end" fontSize="11" fill="var(--muted)">{axisMoney(maxBal * t)}</text>
            </g>
          ))}
          {[0, 0.5, 1].map((t) => (
            <g key={`a${t}`}>
              <line x1={padL} x2={padL + innerW} y1={yA(maxAdd * t)} y2={yA(maxAdd * t)} stroke="var(--line)" strokeWidth="1" />
              <text x={padL - 8} y={yA(maxAdd * t) + 4} textAnchor="end" fontSize="11" fill="var(--muted)">{axisMoney(maxAdd * t)}</text>
            </g>
          ))}
          <text x={padL} y={barTop - 10} fontSize="12" fill="var(--muted)">Added each pay</text>

          {target !== undefined && (
            <g>
              <line x1={padL} x2={padL + innerW} y1={yB(target)} y2={yB(target)} stroke="var(--ink)" strokeWidth="1" opacity="0.5" />
              <text x={padL + innerW} y={yB(target) - 5} textAnchor="end" fontSize="11" fill="var(--ink)">Target {money(target, { whole: true })}</text>
            </g>
          )}
          {dateI >= 0 && (
            <g>
              <line x1={x(dateI)} x2={x(dateI)} y1={6} y2={barTop + barH} stroke="var(--muted)" strokeWidth="1" opacity="0.6" />
              <text x={x(dateI) + 5} y={14} fontSize="11" fill="var(--muted)">Target date</text>
            </g>
          )}

          {area && <path d={area} fill={color} opacity="0.1" />}
          <path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          {reachedI >= 0 && <circle cx={x(reachedI)} cy={yB(points[reachedI].balance)} r="5" fill={color} stroke="var(--card)" strokeWidth="2" />}
          {hover !== null && <circle cx={x(hover)} cy={yB(points[hover].balance)} r="4.5" fill="var(--card)" stroke={color} strokeWidth="2" />}

          {points.map((p, i) => {
            if (p.added <= 0) return null;
            const top = yA(p.added), bh = barTop + barH - top, r = Math.min(4, bh), x0 = x(i) - barW / 2;
            return <path key={`c${i}`} fill={color} opacity={hover === null || hover === i ? 0.7 : 0.35}
              d={`M${x0},${barTop + barH}V${top + r}Q${x0},${top} ${x0 + r},${top}H${x0 + barW - r}Q${x0 + barW},${top} ${x0 + barW},${top + r}V${barTop + barH}Z`} />;
          })}

          {points.map((p, i) => (i % labelEvery === 0 ? (
            <text key={`x${i}`} x={x(i)} y={H - 6} textAnchor="middle" fontSize="11" fill="var(--muted)">{p.label}</text>
          ) : null))}
          {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={6} y2={barTop + barH} stroke="var(--ink)" strokeWidth="1" opacity="0.35" />}
        </svg>

        {h && (
          <div role="status" style={{
            position: 'absolute', top: 8, left: Math.min(Math.max(0, x(hover!) + 12), width - 200), width: 188, pointerEvents: 'none',
            background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 12, padding: '10px 12px',
            boxShadow: '0 6px 20px rgba(0,0,0,0.12)', fontSize: 13, display: 'flex', flexDirection: 'column', gap: 4,
          }}>
            <span className="muted">{monthName(h.period.start)} {h.period.start.slice(0, 4)} pay</span>
            <span className="row" style={{ gap: 8 }}>
              <svg width="14" height="10" aria-hidden="true"><line x1="0" y1="5" x2="14" y2="5" stroke={color} strokeWidth="2" strokeLinecap="round" /></svg>
              <b>{money(h.balance)}</b><span className="muted">saved</span>
            </span>
            <span className="row" style={{ gap: 8 }}>
              <svg width="14" height="10" aria-hidden="true"><rect y="1" width="10" height="8" rx="2" fill={color} opacity="0.7" /></svg>
              <b>{money(h.added)}</b><span className="muted">added this pay</span>
            </span>
            {target !== undefined && <span className="muted">{h.balance >= target ? 'Target reached' : `${money(target - h.balance)} to go`}</span>}
          </div>
        )}
      </div>

      <details>
        <summary className="small" style={{ cursor: 'pointer', fontWeight: 600, minHeight: 32 }}>Show as a table</summary>
        <div style={{ overflowX: 'auto', marginTop: 6 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
            <thead>
              <tr className="muted" style={{ textAlign: 'right' }}>
                <th style={{ textAlign: 'left', padding: '6px 4px', fontWeight: 500 }}>Pay</th>
                <th style={{ padding: '6px 4px', fontWeight: 500 }}>Added</th>
                <th style={{ padding: '6px 4px', fontWeight: 500 }}>Saved</th>
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.period.start} style={{ borderTop: '1px solid var(--line)', textAlign: 'right' }}>
                  <td style={{ textAlign: 'left', padding: '6px 4px' }}>{monthName(p.period.start)} {p.period.start.slice(0, 4)}</td>
                  <td style={{ padding: '6px 4px' }}>{money(p.added)}</td>
                  <td style={{ padding: '6px 4px' }}>{money(p.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <p className="small muted">Projection only: uses what each payday sends (including any one-pay adjustments) and adds no fund returns.</p>
    </section>
  );
}

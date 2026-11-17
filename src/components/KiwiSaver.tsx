import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { AccIcon } from './ui';
import { Donut } from './Donut';
import { Icon } from './Icon';
import { tone } from '../lib/colors';
import { diffDays, fmtShort, todayISO, addMonths, type ISODate } from '../lib/dates';
import { kiwiHistory, kiwiMonths, kiwiPerPay, recordReading, type KiwiMonth } from '../lib/kiwisaver';
import { cash, centsToInput, parseMoney } from '../lib/money';
import { useBudget } from '../lib/store';
import type { SavingsGoal } from '../lib/types';

// ---------------------------------------------------------------------------------------------
// KiwiSaver on the Savings page. It isn't sent anything on payday and you can't add to it or take
// from it, so the card shows what it's worth, what each fund holds, and (opened) how it has done:
// each fund's value over time, what's gone in, and the gain or loss between balances.
// ---------------------------------------------------------------------------------------------

const day = (d: ISODate) => `${fmtShort(d)} ${d.slice(0, 4)}`;
const signed = (c: number, o?: { whole?: boolean }) => `${c < 0 ? '−' : '+'}${cash(Math.abs(c), o)}`;

export function KiwiSaverCard({ goal, onEdit, extra }: { goal: SavingsGoal; onEdit: () => void; extra?: React.ReactNode }) {
  const { budget } = useBudget();
  const [updating, setUpdating] = useState(false);
  const points = useMemo(() => kiwiHistory(budget, goal), [budget, goal]);
  const months = useMemo(() => kiwiMonths(budget, goal), [budget, goal]);
  const last = points[points.length - 1];
  const first = points[0];
  const perPay = kiwiPerPay(budget);
  const acc = budget.accounts.find((a) => a.id === goal.accountId);
  const total = last.funds.reduce((t, f) => t + f.value, 0);
  const slices = last.funds.length ? last.funds.map((f) => ({ label: f.name, value: f.value, color: tone(f.color) })) : [{ label: 'Balance', value: 1, color: tone(acc?.color) }];
  const wentIn = last.putIn - first.balance;

  return (
    <section className="card acct" data-flip={goal.id}>
      <div className="acct-head">
        <AccIcon color={acc?.color} name="piggy" />
        <div className="grow min0">
          <h2 className="h2 clip">{goal.name}</h2>
          <p className="small muted clip">{goal.note && !/bank connection/i.test(goal.note) ? `${goal.note} · ` : ''}From your pay, locked in until 65</p>
        </div>
        <div className="acct-side">
          {extra}
          <button className="icon-btn mini has-tip" data-tip="Add a balance" aria-label={`Add a ${goal.name} balance`} onClick={() => setUpdating(true)}><Icon name="plus" size={14} /></button>
          <button className="icon-btn mini has-tip tip-left" data-tip="Edit" aria-label={`Edit ${goal.name}`} onClick={onEdit}><Icon name="settings" size={14} /></button>
        </div>
      </div>

      <div className="acct-fig">
        <b className="fig">{cash(goal.balance)}</b>
        <span className="xs muted note-line">As at {day(goal.asOf)}</span>
      </div>

      <div className="trio">
        <div className="stat">
          <span className="small muted">Returns</span>
          <b className={points.length > 1 ? (last.returns < 0 ? 'neg' : 'pos') : ''}>{points.length > 1 ? signed(last.returns, { whole: true }) : '—'}</b>
          <span className="xs muted">{points.length > 1 ? `since ${monthYear(first.date)}` : 'needs two balances'}</span>
        </div>
        <div className="stat">
          <span className="small muted">Went in</span>
          <b>{points.length > 1 ? cash(wentIn, { whole: true }) : '—'}</b>
          <span className="xs muted">{points.length > 1 ? `since ${monthYear(first.date)}` : 'contributions'}</span>
        </div>
        <div className="stat">
          <span className="small muted">Each pay</span>
          <b>{perPay && perPay.total > 0 ? cash(perPay.total) : '—'}</b>
          <span className="xs muted">{perPay && perPay.total > 0 ? 'you + employer' : 'from a payslip'}</span>
        </div>
      </div>

      {last.funds.length > 0 && (
        <div className="row wrap gap-16" style={{ alignItems: 'center' }}>
          <Donut size={96} slices={slices}>
            <b className="h3">{last.funds.length}</b>
            <span className="xs muted">fund{last.funds.length === 1 ? '' : 's'}</span>
          </Donut>
          <div className="legend">
            {last.funds.map((f) => (
              <div key={f.name} className="legend-row">
                <span className="dot" style={{ background: tone(f.color) }} />
                <span className="grow min0 clip">{f.name.replace(/^Kernel\s+/, '')}</span>
                <b className="num">{cash(f.value, { whole: true })}</b>
                <span className="pct small muted">{total ? `${Math.round((f.value / total) * 100)}%` : ''}</span>
              </div>
            ))}
            {last.fundsEstimated && <span className="xs muted">Shared out from the last balance with each fund’s value.</span>}
          </div>
        </div>
      )}

      <KiwiChart goal={goal} months={months} color={tone(acc?.color)} />

      {updating && <KiwiBalanceModal goal={goal} onClose={() => setUpdating(false)} />}
    </section>
  );
}

/** Type in a balance (today's, or one from an old statement), with each fund's value if you have them. */
function KiwiBalanceModal({ goal, onClose }: { goal: SavingsGoal; onClose: () => void }) {
  const { update } = useBudget();
  const latest = [...(goal.readings ?? [])].reverse().find((r) => r.funds);
  const [date, setDate] = useState(todayISO());
  const [funds, setFunds] = useState<{ name: string; value: string }[]>(
    (goal.funds ?? []).map((f) => ({ name: f.name, value: '' })).filter((f) => !latest || latest.funds![f.name] !== undefined),
  );
  const [total, setTotal] = useState('');
  const [err, setErr] = useState('');
  const named = funds.filter((f) => f.name.trim() || f.value.trim());
  const parsed = named.map((f) => ({ name: f.name.trim(), cents: f.value.trim() ? parseMoney(f.value) : null }));
  const sum = parsed.reduce((t, f) => t + (f.cents ?? 0), 0);

  function save() {
    if (!date) return setErr('Enter the date.');
    if (date > todayISO()) return setErr('That date is in the future.');
    let balance: number | null;
    let values: Record<string, number> | undefined;
    if (named.length) {
      if (parsed.some((f) => !f.name)) return setErr('Give each fund a name.');
      if (parsed.some((f) => f.cents === null || f.cents < 0)) return setErr('Check each fund’s value.');
      values = Object.fromEntries(parsed.map((f) => [f.name, f.cents!]));
      balance = sum;
    } else balance = parseMoney(total);
    if (balance === null || balance <= 0) return setErr('Enter the balance.');
    update((b) => {
      const g = (b.savings ?? []).find((x) => x.id === goal.id);
      if (g) recordReading(g, { date, balance: balance!, ...(values ? { funds: values } : {}) });
      return b;
    });
    onClose();
  }

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="kiwi-title" onClick={(e) => e.stopPropagation()}>
        <div className="between">
          <h2 id="kiwi-title" className="h2">Add a {goal.name} balance</h2>
          <button className="icon-btn plain" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
        </div>
        <label className="field">As at
          <input type="date" value={date} max={todayISO()} onChange={(e) => { setDate(e.target.value); setErr(''); }} />
        </label>
        <div className="stack gap-8">
          <b className="small">Each fund’s value</b>
          {funds.map((f, i) => (
            <div key={i} className="row nowrap gap-8">
              <input aria-label="Fund" value={f.name} placeholder="High Growth" onChange={(e) => setFunds(funds.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
              <input aria-label={`${f.name || 'Fund'} value`} inputMode="decimal" value={f.value} placeholder="0.00" onChange={(e) => { setFunds(funds.map((x, j) => (j === i ? { ...x, value: e.target.value } : x))); setErr(''); }} />
              <button className="icon-btn plain" aria-label={`Remove ${f.name || 'fund'}`} onClick={() => setFunds(funds.filter((_, j) => j !== i))}><Icon name="x" size={16} /></button>
            </div>
          ))}
          <button className="btn small" style={{ alignSelf: 'flex-start' }} onClick={() => setFunds([...funds, { name: '', value: '' }])}><Icon name="plus" size={16} /> Add a fund</button>
          {named.length > 0 && <span className="small">Balance: <b>{cash(sum)}</b></span>}
        </div>
        {named.length === 0 && (
          <label className="field">Balance
            <input inputMode="decimal" value={total} placeholder={centsToInput(goal.balance)} onChange={(e) => { setTotal(e.target.value); setErr(''); }} />
          </label>
        )}
        <p className="small muted">A statement or breakdown from your provider fills in what went in and what it earned too: upload it with Add → Upload a document.</p>
        {err && <p className="error" role="alert">{err}</p>}
        <div className="row end">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save}>Add</button>
        </div>
      </div>
    </div>
  );
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
  if (v <= 0) return 100000;
  const d = v / 100;
  const pow = 10 ** Math.floor(Math.log10(d));
  const step = [1, 2, 2.5, 5, 10].find((m) => m * pow * 4 >= d) ?? 10;
  return step * pow * 4 * 100;
}
const axisMoney = (c: number) => {
  const d = Math.abs(c) / 100;
  const s = d >= 10000 ? `$${Math.round(d / 1000)}K` : `$${d.toLocaleString('en-NZ', { maximumFractionDigits: 0 })}`;
  return c < 0 ? `−${s}` : s;
};

const RANGES = [{ months: 12, label: '1Y' }, { months: 36, label: '3Y' }, { months: 0, label: 'All' }];
const monthYear = (d: ISODate) => `${fmtShort(d).replace(/^\d+\s/, '')} ${d.slice(0, 4)}`;

/**
 * What it's worth month by month (each real balance a dot, the months between worked out from what
 * went in), what's gone in (dashed), and below, what went in each month. The gap between the two
 * lines is the returns.
 */
function KiwiChart({ goal, months: all, color }: { goal: SavingsGoal; months: KiwiMonth[]; color: string }) {
  const today = todayISO();
  const [range, setRange] = useState(0);
  const [hovered, setHover] = useState<number | null>(null);
  const [wrapRef, width] = useWidth<HTMLDivElement>();

  if (all.length < 2) {
    return (
      <p className="small muted">
        The chart shows once there are two balances. Upload a statement from your provider (Add → Upload a document), or add a balance with +.
      </p>
    );
  }

  const from = range ? addMonths(today, -range) : '';
  const startI = from ? Math.max(0, all.findIndex((p) => p.date >= from) - 1) : 0;
  const months = from && all.some((p) => p.date >= from) ? all.slice(startI) : all;

  const padL = 56, padR = 64, topH = 200, barH = 64, gap = 64, axisH = 22;
  const innerW = Math.max(120, width - padL - padR);
  const t0 = months[0].date, span = Math.max(1, diffDays(t0, months[months.length - 1].date));
  const x = (d: ISODate) => padL + (diffDays(t0, d) / span) * innerW;
  const minBal = 0;
  const maxBal = niceMax(Math.max(...months.map((p) => Math.max(p.balance, p.putIn))));
  const yB = (v: number) => 12 + (1 - (v - minBal) / (maxBal - minBal)) * (topH - 12);
  const bars = months.slice(1);
  // Scaled to the biggest month, so the bars fill their space.
  const maxAdd = Math.max(100, ...bars.map((b) => b.added)) * 1.1;
  const barTop = topH + gap;
  const yA = (v: number) => barTop + barH - (v / maxAdd) * barH;
  const H = barTop + barH + axisH;
  const step = innerW / Math.max(1, months.length - 1);

  const line = months.map((p, i) => `${i ? 'L' : 'M'}${x(p.date).toFixed(1)},${yB(p.balance).toFixed(1)}`).join('');
  const area = `${line}L${x(months[months.length - 1].date).toFixed(1)},${yB(minBal)}L${padL},${yB(minBal)}Z`;
  const putIn = months.map((p, i) => `${i ? 'L' : 'M'}${x(p.date).toFixed(1)},${yB(p.putIn).toFixed(1)}`).join('');
  const last = months[months.length - 1];
  const returns = last.balance - last.putIn - (months[0].balance - months[0].putIn);
  const summary = `${goal.name} went from ${cash(months[0].balance, { whole: true })} in ${monthYear(months[0].date)} to ${cash(last.balance, { whole: true })}: ${cash(last.putIn - months[0].putIn, { whole: true })} went in, and ${returns < 0 ? `${cash(-returns, { whole: true })} was lost` : `${cash(returns, { whole: true })} came from returns`}.`;

  function onMove(e: PointerEvent<SVGSVGElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left;
    let best = 0;
    months.forEach((p, i) => { if (Math.abs(x(p.date) - px) < Math.abs(x(months[best].date) - px)) best = i; });
    setHover(best);
  }
  function onKey(e: KeyboardEvent<SVGSVGElement>) {
    if (e.key === 'ArrowRight') { setHover((h) => Math.min(months.length - 1, (h ?? -1) + 1)); e.preventDefault(); }
    if (e.key === 'ArrowLeft') { setHover((h) => Math.max(0, (h ?? 1) - 1)); e.preventDefault(); }
  }
  const h = hovered !== null && hovered < months.length ? months[hovered] : null;
  // One label a month at most, never closer than 64px (the last one always shows, the one before it gives way).
  const labels = (() => {
    const out: ISODate[] = [];
    const pts = months.filter((p, i) => i === months.length - 1 || months[i + 1].date.slice(0, 7) !== p.date.slice(0, 7));
    for (const p of pts) if (!out.length || x(p.date) - x(out[out.length - 1]) >= 64) out.push(p.date);
    const lastDate = months[months.length - 1].date;
    if (out[out.length - 1] !== lastDate) { if (x(lastDate) - x(out[out.length - 1]) < 64) out.pop(); out.push(lastDate); }
    return out;
  })();


  return (
    <div className="stack gap-12">
      <div className="row wrap gap-8 between">
        <b className="h3">Value over time</b>
        <div className="seg" role="group" aria-label="How far back">
          {RANGES.map((r) => <button key={r.label} aria-pressed={range === r.months} onClick={() => { setRange(r.months); setHover(null); }}>{r.label}</button>)}
        </div>
      </div>

      <div ref={wrapRef} style={{ position: 'relative', width: '100%' }}>
        <svg width={width} height={H} role="img" aria-label={`${summary} Use the left and right arrow keys to read each month.`}
          tabIndex={0} onPointerMove={onMove} onPointerLeave={() => setHover(null)} onKeyDown={onKey} onBlur={() => setHover(null)}
          style={{ display: 'block', touchAction: 'pan-y', outline: 'none' }}>
          {[0, 0.25, 0.5, 0.75, 1].map((t) => {
            const v = minBal + (maxBal - minBal) * t;
            return (
              <g key={`b${t}`}>
                <line x1={padL} x2={padL + innerW} y1={yB(v)} y2={yB(v)} stroke="var(--line)" strokeWidth="1" />
                <text x={padL - 8} y={yB(v) + 4} textAnchor="end" fontSize="11" fill="var(--muted)">{axisMoney(v)}</text>
              </g>
            );
          })}
          <path d={area} fill={color} opacity="0.14" />
          <path d={line} fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round" />
          <path d={putIn} fill="none" stroke="var(--ink)" strokeWidth="1.5" strokeDasharray="5 4" opacity="0.6" />
          {/* The two lines named where they end, instead of a key. */}
          <text x={x(last.date) + 8} y={yB(last.balance) + 4} fontSize="11" fontWeight="700" fill={color}>{axisMoney(last.balance)}</text>
          <text x={x(last.date) + 8} y={yB(last.putIn) + 4} fontSize="11" fill="var(--muted)">put in</text>

          <line x1={0} x2={width} y1={topH + axisH + 8} y2={topH + axisH + 8} stroke="var(--line)" strokeWidth="1" />
          <text x={0} y={barTop - 12} fontSize="13" fontWeight="700" fill="var(--ink)">Went in each month</text>
          <line x1={padL} x2={padL + innerW} y1={barTop + barH} y2={barTop + barH} stroke="var(--line)" strokeWidth="1" />
          <text x={padL - 8} y={yA(maxAdd / 1.1) + 4} textAnchor="end" fontSize="11" fill="var(--muted)">{axisMoney(maxAdd / 1.1)}</text>
          <line x1={padL} x2={padL + innerW} y1={yA(maxAdd / 1.1)} y2={yA(maxAdd / 1.1)} stroke="var(--line)" strokeWidth="1" strokeDasharray="2 3" />
          {bars.map((b) => {
            const w = Math.max(2, Math.min(18, step * 0.6));
            const bh = Math.max(b.added > 0 ? 1 : 0, barTop + barH - yA(b.added));
            const active = h?.date === b.date;
            return <rect key={`a${b.date}`} x={x(b.date) - w / 2} y={barTop + barH - bh} width={w} height={bh} rx={Math.min(3, w / 2)}
              fill={color} opacity={h && !active ? 0.35 : 0.85} />;
          })}

          {labels.map((d, i) => [topH + 16, H - 6].map((y) => (
            <text key={`${d}${y}`} x={x(d)} y={y} textAnchor={i === 0 ? 'start' : 'middle'} fontSize="11" fill="var(--muted)">
              {fmtShort(d).replace(/^\d+\s/, '')} {d.slice(2, 4)}
            </text>
          )))}
          {h && (
            <g>
              <line x1={x(h.date)} x2={x(h.date)} y1={6} y2={topH} stroke="var(--ink)" strokeWidth="1" opacity="0.35" />
              <line x1={x(h.date)} x2={x(h.date)} y1={barTop} y2={barTop + barH} stroke="var(--ink)" strokeWidth="1" opacity="0.35" />
              <circle cx={x(h.date)} cy={yB(h.balance)} r="4.5" fill="var(--card)" stroke="var(--ink)" strokeWidth="2" />
            </g>
          )}
        </svg>

        {h && (
          <div role="status" className="pop-card" style={{ position: 'absolute', top: 8, left: Math.min(Math.max(0, x(h.date) + 12), width - 220), width: 208 }}>
            <span className="muted">{h.actual ? day(h.date) : `End of ${monthYear(h.date)}`}</span>
            <span className="row gap-8"><b>{cash(h.balance, { whole: true })}</b><span className="muted">{h.actual ? 'balance' : 'about'}</span></span>
            <span className="row gap-8"><span className="grow muted">Went in that month</span><span>{cash(h.added, { whole: true })}</span></span>
            <span className="row gap-8"><span className="grow muted">Went in, all told</span><span>{cash(h.putIn, { whole: true })}</span></span>
            <span className="row gap-8"><span className="grow muted">Returns</span><span className={h.balance - h.putIn < 0 ? 'neg' : 'pos'}>{signed(h.balance - h.putIn, { whole: true })}</span></span>
          </div>
        )}
      </div>
    </div>
  );
}

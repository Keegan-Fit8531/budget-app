import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Disclosure } from './ui';
import { Icon } from './Icon';
import { tone } from '../lib/colors';
import { diffDays, fmtShort, todayISO, addMonths, type ISODate } from '../lib/dates';
import { kiwiHistory, kiwiPerPay, recordReading, type KiwiPoint } from '../lib/kiwisaver';
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

export function KiwiSaverCard({ goal, onEdit }: { goal: SavingsGoal; onEdit: () => void }) {
  const { budget } = useBudget();
  const [updating, setUpdating] = useState(false);
  const points = useMemo(() => kiwiHistory(budget, goal), [budget, goal]);
  const last = points[points.length - 1];
  const first = points[0];
  const perPay = kiwiPerPay(budget);
  const acc = budget.accounts.find((a) => a.id === goal.accountId);
  const total = last.funds.reduce((t, f) => t + f.value, 0);

  return (
    <section className="card stack gap-12">
      <div className="between nowrap top">
        <div className="min0">
          <h2 className="h2">{goal.name}</h2>
          <p className="small muted">{[goal.note, 'From your pay, locked in until 65'].filter(Boolean).join(' · ')}</p>
        </div>
        <button className="btn small" onClick={onEdit}><Icon name="edit" size={16} /> Edit</button>
      </div>

      <div className="stack gap-2">
        <span className="fig">{cash(goal.balance)}</span>
        <span className="small muted">Balance, {day(goal.asOf)}</span>
        {points.length > 1 && (
          <span className={`small strong ${last.returns < 0 ? 'neg' : 'pos'}`}>
            {signed(last.returns)} {last.returns < 0 ? 'lost' : 'returns'} since {day(first.date)}
          </span>
        )}
        {perPay && perPay.total > 0 && (
          <span className="small muted">{cash(perPay.total)} goes in each pay: {cash(perPay.you)} from you, {cash(perPay.employer)} from your employer after tax</span>
        )}
      </div>

      {last.funds.length > 0 && (
        <div className="legend" style={{ flex: "none" }}>
          {last.funds.map((f) => (
            <div key={f.name} className="legend-row">
              <span className="dot" style={{ background: tone(f.color) }} />
              <span className="grow">{f.name}</span>
              <b>{cash(f.value)}</b>
              <span className="pct small muted">{total ? `${((f.value / total) * 100).toFixed(1)}%` : ''}</span>
            </div>
          ))}
          {last.fundsEstimated && <span className="xs muted">Each fund’s share of today’s balance, from the split on the last balance with funds.</span>}
        </div>
      )}

      <div className="row wrap gap-8">
        <button className="btn small" onClick={() => setUpdating(true)}><Icon name="plus" size={16} /> Add a balance</button>
      </div>

      <Disclosure title="Gains and losses" meta={points.length > 1 ? `since ${day(first.date)}` : undefined} storageKey={`paydays.kiwi.${goal.id}`}>
        <KiwiChart goal={goal} points={points} color={tone(acc?.color)} />
      </Disclosure>

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

const RANGES = [{ months: 3, label: '3M' }, { months: 12, label: '1Y' }, { months: 36, label: '3Y' }, { months: 0, label: 'All' }];

/** A gain or loss between two kept balances (one a month at most, so daily bank balances don't make hairline bars). */
interface Bar { from: KiwiPoint; to: KiwiPoint; gain: number; stated: boolean; inKnown: boolean }

function barsFor(points: KiwiPoint[]): Bar[] {
  // The last balance in each month, and the very first.
  const kept = points.filter((p, i) => i === 0 || i === points.length - 1 || points[i + 1].date.slice(0, 7) !== p.date.slice(0, 7));
  const out: Bar[] = [];
  for (let i = 1; i < kept.length; i++) {
    const span = points.slice(points.indexOf(kept[i - 1]) + 1, points.indexOf(kept[i]) + 1);
    out.push({ from: kept[i - 1], to: kept[i], gain: kept[i].returns - kept[i - 1].returns, stated: span.every((p) => p.stated), inKnown: span.every((p) => p.inKnown) });
  }
  return out;
}

function KiwiChart({ goal, points: all, color }: { goal: SavingsGoal; points: KiwiPoint[]; color: string }) {
  const { update } = useBudget();
  const today = todayISO();
  const [range, setRange] = useState(0);
  const [hovered, setHover] = useState<number | null>(null);
  const [wrapRef, width] = useWidth<HTMLDivElement>();

  const from = range ? addMonths(today, -range) : '';
  // The balance just before the window starts too, so its first gain shows.
  const startI = from ? Math.max(0, all.findIndex((p) => p.date >= from) - 1) : 0;
  const points = from && all.some((p) => p.date >= from) ? all.slice(startI) : all;
  const bars = useMemo(() => barsFor(points), [points]);

  if (all.length < 2) {
    return (
      <p className="small muted">
        Gains and losses show once there are two balances. Upload a statement or breakdown from your provider (Add → Upload a document): its
        opening and closing values, contributions and returns go straight in. Each balance the bank connection brings in is kept too.
      </p>
    );
  }

  const fundNames = (goal.funds ?? []).filter((f) => points.some((p) => p.funds.some((x) => x.name === f.name)));
  const stacked = fundNames.length > 0;
  const padL = 56, padR = 12, topH = 200, barH = 90, gap = 34, axisH = 22;
  const innerW = Math.max(120, width - padL - padR);
  const t0 = points[0].date, span = Math.max(1, diffDays(t0, points[points.length - 1].date));
  const x = (d: ISODate) => padL + (diffDays(t0, d) / span) * innerW;
  const maxBal = niceMax(Math.max(...points.map((p) => Math.max(p.balance, p.putIn))));
  const yB = (v: number) => 12 + (1 - v / maxBal) * (topH - 12);
  const maxGain = niceMax(Math.max(1, ...bars.map((b) => Math.abs(b.gain))));
  const barTop = topH + gap;
  const zero = barTop + barH / 2;
  const yG = (v: number) => zero - (v / maxGain) * (barH / 2);
  const H = barTop + barH + axisH;

  // Stacked fund areas: each fund sits on the ones before it, in the goal's fund order.
  const layers = stacked
    ? fundNames.map((f, k) => {
      const lower = points.map((p) => fundNames.slice(0, k).reduce((t, g) => t + (p.funds.find((x) => x.name === g.name)?.value ?? 0), 0));
      const upper = points.map((p, i) => lower[i] + (p.funds.find((x) => x.name === f.name)?.value ?? 0));
      const top = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.date).toFixed(1)},${yB(upper[i]).toFixed(1)}`).join('');
      const bottom = [...points].reverse().map((p, j) => `L${x(p.date).toFixed(1)},${yB(lower[points.length - 1 - j]).toFixed(1)}`).join('');
      return { f, d: `${top}${bottom}Z` };
    })
    : [];
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.date).toFixed(1)},${yB(p.balance).toFixed(1)}`).join('');
  const area = `${line}L${x(points[points.length - 1].date).toFixed(1)},${yB(0)}L${padL},${yB(0)}Z`;
  const putIn = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.date).toFixed(1)},${yB(p.putIn).toFixed(1)}`).join('');

  const last = points[points.length - 1];
  const gained = last.returns - points[0].returns;
  const summary = `${goal.name}: ${cash(points[0].balance, { whole: true })} on ${day(points[0].date)} to ${cash(last.balance, { whole: true })} on ${day(last.date)}, ${gained < 0 ? `a loss of ${cash(-gained, { whole: true })}` : `${cash(gained, { whole: true })} of returns`} on top of what went in.`;

  function onMove(e: PointerEvent<SVGSVGElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left;
    let best = 0;
    points.forEach((p, i) => { if (Math.abs(x(p.date) - px) < Math.abs(x(points[best].date) - px)) best = i; });
    setHover(best);
  }
  function onKey(e: KeyboardEvent<SVGSVGElement>) {
    if (e.key === 'ArrowRight') { setHover((h) => Math.min(points.length - 1, (h ?? -1) + 1)); e.preventDefault(); }
    if (e.key === 'ArrowLeft') { setHover((h) => Math.max(0, (h ?? 1) - 1)); e.preventDefault(); }
  }
  const hover = hovered !== null && hovered < points.length ? hovered : null;
  const h = hover !== null ? points[hover] : null;
  const hBar = h ? bars.find((b) => b.from.date < h.date && b.to.date >= h.date) : undefined;
  const labels = (() => {
    const n = Math.max(2, Math.floor(innerW / 80));
    return Array.from({ length: n }, (_, i) => {
      const d = new Date(`${t0}T00:00:00`);
      d.setDate(d.getDate() + Math.round((span * i) / (n - 1)));
      return d.toISOString().slice(0, 10);
    });
  })();
  const remove = (date: ISODate) => {
    if (!confirm(`Take the ${day(date)} balance out of the history?`)) return;
    update((b) => {
      const g = (b.savings ?? []).find((x) => x.id === goal.id);
      if (g) g.readings = (g.readings ?? []).filter((r) => r.date !== date);
      return b;
    });
  };

  return (
    <div className="stack gap-12">
      <span className="small muted">{summary}</span>
      <div className="row wrap gap-8 between">
        <div className="row wrap gap-12 small" aria-label="Legend">
          {stacked ? fundNames.map((f) => (
            <span key={f.name} className="row gap-6"><span className="dot" style={{ background: tone(f.color) }} />{f.name}</span>
          )) : <span className="row gap-6"><span className="dot" style={{ background: color }} />Balance</span>}
          <span className="row gap-6"><svg width="16" height="10" aria-hidden="true"><line x1="0" y1="5" x2="16" y2="5" stroke="var(--ink)" strokeWidth="2" strokeDasharray="4 3" /></svg>What went in</span>
        </div>
        <div className="seg" role="group" aria-label="How far back">
          {RANGES.map((r) => <button key={r.label} aria-pressed={range === r.months} onClick={() => { setRange(r.months); setHover(null); }}>{r.label}</button>)}
        </div>
      </div>

      <div ref={wrapRef} style={{ position: 'relative', width: '100%' }}>
        <svg width={width} height={H} role="img" aria-label={`${summary} Use the left and right arrow keys to read each balance.`}
          tabIndex={0} onPointerMove={onMove} onPointerLeave={() => setHover(null)} onKeyDown={onKey} onBlur={() => setHover(null)}
          style={{ display: 'block', touchAction: 'pan-y', outline: 'none' }}>
          {[0, 0.25, 0.5, 0.75, 1].map((t) => (
            <g key={`b${t}`}>
              <line x1={padL} x2={padL + innerW} y1={yB(maxBal * t)} y2={yB(maxBal * t)} stroke="var(--line)" strokeWidth="1" />
              <text x={padL - 8} y={yB(maxBal * t) + 4} textAnchor="end" fontSize="11" fill="var(--muted)">{axisMoney(maxBal * t)}</text>
            </g>
          ))}
          {[-1, 0, 1].map((t) => (
            <g key={`g${t}`}>
              <line x1={padL} x2={padL + innerW} y1={yG(maxGain * t)} y2={yG(maxGain * t)} stroke={t === 0 ? 'var(--muted)' : 'var(--line)'} strokeWidth="1" opacity={t === 0 ? 0.6 : 1} />
              <text x={padL - 8} y={yG(maxGain * t) + 4} textAnchor="end" fontSize="11" fill="var(--muted)">{axisMoney(maxGain * t)}</text>
            </g>
          ))}
          <text x={padL} y={barTop - 10} fontSize="12" fill="var(--muted)">Gain or loss</text>

          {stacked
            ? layers.map(({ f, d }) => <path key={f.name} d={d} fill={tone(f.color)} opacity="0.85" stroke="var(--card)" strokeWidth="2" strokeLinejoin="round" />)
            : <><path d={area} fill={color} opacity="0.12" /><path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" /></>}
          <path d={putIn} fill="none" stroke="var(--ink)" strokeWidth="2" strokeDasharray="5 4" opacity="0.7" />

          {bars.map((b) => {
            const x0 = x(b.from.date) + 1, x1 = x(b.to.date) - 1;
            const w = Math.max(2, x1 - x0);
            const top = Math.min(yG(b.gain), zero), bh = Math.max(1, Math.abs(yG(b.gain) - zero));
            const r = Math.min(4, bh, w / 2);
            const up = b.gain >= 0;
            const active = hBar === b;
            // Rounded at the data end only: the top of a gain, the bottom of a loss.
            const d = up
              ? `M${x0},${zero}V${top + r}Q${x0},${top} ${x0 + r},${top}H${x0 + w - r}Q${x0 + w},${top} ${x0 + w},${top + r}V${zero}Z`
              : `M${x0},${zero}V${top + bh - r}Q${x0},${top + bh} ${x0 + r},${top + bh}H${x0 + w - r}Q${x0 + w},${top + bh} ${x0 + w},${top + bh - r}V${zero}Z`;
            return <path key={b.to.date} d={d} fill={up ? 'var(--good)' : 'var(--bad)'} opacity={hBar === undefined || active ? (b.stated ? 0.85 : 0.6) : 0.3} />;
          })}

          {labels.map((d, i) => (
            <text key={d} x={x(d)} y={H - 6} textAnchor={i === 0 ? 'start' : i === labels.length - 1 ? 'end' : 'middle'} fontSize="11" fill="var(--muted)">
              {fmtShort(d).replace(/^\d+\s/, '')} {d.slice(2, 4)}
            </text>
          ))}
          {h && (
            <g>
              <line x1={x(h.date)} x2={x(h.date)} y1={6} y2={barTop + barH} stroke="var(--ink)" strokeWidth="1" opacity="0.35" />
              <circle cx={x(h.date)} cy={yB(h.balance)} r="4.5" fill="var(--card)" stroke="var(--ink)" strokeWidth="2" />
            </g>
          )}
        </svg>

        {h && (
          <div role="status" className="pop-card" style={{ position: 'absolute', top: 8, left: Math.min(Math.max(0, x(h.date) + 12), width - 220), width: 208 }}>
            <span className="muted">{day(h.date)}</span>
            <span className="row gap-8"><b>{cash(h.balance)}</b><span className="muted">balance</span></span>
            {h.funds.map((f) => (
              <span key={f.name} className="row gap-8">
                <span className="dot sm" style={{ background: tone(f.color) }} />
                <span className="grow">{f.name}</span><span>{cash(f.value, { whole: true })}</span>
              </span>
            ))}
            {h.fundsEstimated && h.funds.length > 0 && <span className="xs muted">Funds shared out from another day’s split</span>}
            <span className="row gap-8"><span className="grow muted">What went in</span><span>{cash(h.putIn, { whole: true })}</span></span>
            <span className="row gap-8"><span className="grow muted">Returns so far</span><span className={h.returns < 0 ? 'neg' : 'pos'}>{signed(h.returns, { whole: true })}</span></span>
            {hBar && (
              <span className="row gap-8"><span className="grow muted">Since {fmtShort(hBar.from.date)}</span><span className={hBar.gain < 0 ? 'neg' : 'pos'}>{signed(hBar.gain)}</span></span>
            )}
          </div>
        )}
      </div>

      <Disclosure title="Show as a table">
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr><th>Date</th><th>Balance</th><th>What went in</th><th>Gain or loss</th><th><span className="sr-only">Remove</span></th></tr>
            </thead>
            <tbody>
              {[...all].reverse().map((p, i) => (
                <tr key={p.date}>
                  <td>{day(p.date)}</td>
                  <td>{cash(p.balance)}</td>
                  <td>{cash(p.putIn)}</td>
                  <td className={p.gain < 0 ? 'neg' : p.gain > 0 ? 'pos' : ''}>{i === all.length - 1 ? '' : `${signed(p.gain)}${p.stated ? '' : ' *'}`}</td>
                  <td>{(goal.readings ?? []).some((r) => r.date === p.date) && (
                    <button className="icon-btn plain" aria-label={`Remove the ${day(p.date)} balance`} onClick={() => remove(p.date)}><Icon name="x" size={16} /></button>
                  )}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Disclosure>
      <p className="small muted">
        A gain or loss is the change in balance less what went in. Where a statement says what went in and what was earned (after PIE tax),
        its figures are used; * marks one worked out from your payslips instead (your contribution, plus your employer’s after its tax), so a month can
        look up or down depending on when contributions reach the fund, and the yearly government contribution shows as a gain.
      </p>
    </div>
  );
}

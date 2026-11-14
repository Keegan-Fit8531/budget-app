import { useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { tone } from '../lib/colors';
import { cash } from '../lib/money';
import { Dot } from './ui';

export interface Slice { label: string; value: number; color: string }

/** The gap between slices, as a share of the whole ring, so neighbours never touch. */
const GAP = 0.004;

/**
 * A pie (ring) chart. Hover or tap a slice to see who/what it is, its share and the amount;
 * the other slices fade so the one you're on stands out.
 */
export function Donut({ slices, size = 200, children }: { slices: Slice[]; size?: number; children?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ i: number } | null>(null);
  const shown = slices.filter((s) => s.value > 0);
  const total = shown.reduce((s, x) => s + x.value, 0) || 1;
  let acc = 0;
  const ranges = shown.map((s) => { const a = acc / total; acc += s.value; return [a, acc / total] as const; });
  const gap = shown.length > 1 ? GAP : 0;
  const stops = shown.flatMap((s, i) => {
    const c = hover && hover.i !== i ? `color-mix(in srgb, ${tone(s.color)} 35%, var(--card))` : tone(s.color);
    const end = Math.max(ranges[i][0], ranges[i][1] - gap);
    return [`${c} ${ranges[i][0] * 100}% ${end * 100}%`, ...(gap ? [`var(--card) ${end * 100}% ${ranges[i][1] * 100}%`] : [])];
  });
  const pct = (s: Slice) => Math.round((s.value / total) * 100);
  const label = shown.map((s) => `${s.label} ${pct(s)}%`).join(', ');

  function pick(e: PointerEvent<HTMLDivElement>) {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const dx = e.clientX - r.left - r.width / 2, dy = e.clientY - r.top - r.height / 2;
    const d = Math.hypot(dx, dy);
    // Only the ring counts, not the hole in the middle or the corners.
    if (d < r.width * 0.33 || d > r.width / 2) return setHover(null);
    const turn = ((Math.atan2(dx, -dy) / (2 * Math.PI)) + 1) % 1; // 0 at the top, clockwise (like the gradient)
    const i = ranges.findIndex(([a, b]) => turn >= a && turn < b);
    setHover(i >= 0 ? { i } : null);
  }

  const h = hover ? shown[hover.i] : undefined;
  return (
    <div ref={ref} className="donut" role="img" aria-label={label}
      onPointerMove={pick} onPointerDown={pick} onPointerLeave={(e) => { if (e.pointerType === 'mouse') setHover(null); }}
      style={{ position: 'relative', width: size, height: size, touchAction: 'manipulation', background: stops.length ? `conic-gradient(${stops.join(',')})` : 'var(--soft)' }}>
      <div style={{ width: size * 0.68, height: size * 0.68 }}>{children}</div>
      {h && hover && (
        <span role="tooltip" className="pop" style={{ position: 'absolute', left: '50%', bottom: '100%', transform: 'translate(-50%, -6px)', whiteSpace: 'nowrap', zIndex: 5 }}>
          <span className="row gap-6"><Dot color={h.color} small /><b>{h.label}</b> · {pct(h)}%</span>
          {shown.length > 1 && <span className="block" style={{ opacity: 0.8 }}>{cash(h.value, { whole: true })}</span>}
        </span>
      )}
    </div>
  );
}

/** Each slice's name and share; with `amounts`, its amount too (largest first, so the big ones are read first). */
export function Legend({ slices, amounts }: { slices: Slice[]; amounts?: boolean }) {
  const total = slices.reduce((s, x) => s + Math.max(0, x.value), 0) || 1;
  const shown = slices.filter((s) => s.value > 0);
  if (amounts) shown.sort((a, b) => b.value - a.value);
  return (
    <div className="legend">
      {shown.map((s) => (
        <div key={s.label} className="legend-row">
          <Dot color={s.color} />
          <span className="grow clip">{s.label}</span>
          {amounts && <span className="num muted">{cash(s.value, { whole: true })}</span>}
          <b className="num pct">{Math.round((s.value / total) * 100)}%</b>
        </div>
      ))}
    </div>
  );
}

/**
 * A ranked list for many items (e.g. every account): name, amount and share, each with its own
 * thin bar. Easier to read than a ring with a dozen slices, and the colour is only a mark.
 */
export function BarList({ slices }: { slices: Slice[] }) {
  const shown = slices.filter((s) => s.value > 0).sort((a, b) => b.value - a.value);
  const total = shown.reduce((s, x) => s + x.value, 0) || 1;
  const max = shown[0]?.value || 1;
  return (
    <div className="bar-list" role="list">
      {shown.map((s) => (
        <div key={s.label} className="bar-list-row" role="listitem">
          <span className="row gap-8 min0"><Dot color={s.color} /><span className="clip">{s.label}</span></span>
          <span className="num muted">{cash(s.value, { whole: true })}</span>
          <b className="num right">{Math.round((s.value / total) * 100)}%</b>
          <div className="track" aria-hidden="true"><div style={{ width: `${(s.value / max) * 100}%`, background: tone(s.color) }} /></div>
        </div>
      ))}
    </div>
  );
}

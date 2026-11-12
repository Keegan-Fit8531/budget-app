import { useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { money } from '../lib/money';

export interface Slice { label: string; value: number; color: string }

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
  const stops = shown.map((s, i) => {
    const c = hover && hover.i !== i ? `color-mix(in srgb, ${s.color} 35%, var(--card))` : s.color;
    return `${c} ${ranges[i][0] * 100}% ${ranges[i][1] * 100}%`;
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
      style={{ position: 'relative', width: size, height: size, flex: '0 0 auto', touchAction: 'manipulation', background: stops.length ? `conic-gradient(${stops.join(',')})` : 'var(--soft)' }}>
      <div style={{ width: size * 0.66, height: size * 0.66 }}>{children}</div>
      {h && hover && (
        <div role="tooltip" style={{
          position: 'absolute', left: '50%', bottom: '100%', transform: 'translate(-50%, -6px)',
          background: 'var(--ink)', color: 'var(--card)', borderRadius: 10, padding: '6px 10px', fontSize: 13, lineHeight: 1.3,
          whiteSpace: 'nowrap', pointerEvents: 'none', zIndex: 5, display: 'block', textAlign: 'left', width: 'auto', height: 'auto', boxShadow: '0 4px 14px rgba(0,0,0,.18)',
        }}>
          <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: h.color, marginRight: 6 }} />
          <b>{h.label}</b> · {pct(h)}%
          {shown.length > 1 && <span style={{ display: 'block', opacity: 0.8 }}>{money(h.value, { whole: true })}</span>}
        </div>
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 14, flex: '1 1 180px', minWidth: 0 }}>
      {shown.map((s) => (
        <div key={s.label} className="row" style={{ gap: 10 }}>
          <span className="dot" style={{ background: s.color }} />
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.label}</span>
          {amounts && <span className="num muted">{money(s.value, { whole: true })}</span>}
          <b className="num" style={amounts ? { width: 38, textAlign: 'right' } : undefined}>{Math.round((s.value / total) * 100)}%</b>
        </div>
      ))}
    </div>
  );
}

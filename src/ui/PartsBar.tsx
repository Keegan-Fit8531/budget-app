import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { cash } from '../core/money';
import { Dot } from './components';

/** The key's entries: parts with the same `key` name (each bill to come: "Bills") added up, in order of first use. */
function keyOf(parts: Part[]) {
  const out: { name: string; value: number; color: string }[] = [];
  for (const p of parts) {
    if (p.noKey) continue;
    const name = p.key ?? p.label;
    const k = out.find((x) => x.name === name);
    if (k) k.value += p.value; else out.push({ name, value: p.value, color: p.color });
  }
  return out;
}

/**
 * `key`: the name in the key under a `keyed` bar; parts with the same one are added up there (every bill: "Bills").
 * `noKey`: left out of the key, for a part a figure beside the bar already names (Paid, Spare), so the key stays one line.
 */
export interface Part { label: string; value: number; color: string; note?: string; key?: string; noKey?: boolean }

/**
 * One bar split into parts (paid, still to come, put aside, spare). Point at it, or tap or slide a finger along
 * it, and a tip above shows the part you're on: its name and amount. The others fade. The part is picked
 * from how far along the bar you are, so you don't have to land on a thin part exactly, and the tip floats,
 * so nothing on the card moves. A tap elsewhere hides it.
 * `keyed`: one small line underneath names each kind of part with its total (not the `noKey` ones), so the split reads without tapping.
 */
export function PartsBar({ parts, label, thin, keyed }: { parts: Part[]; label: string; thin?: boolean; keyed?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [on, setOn] = useState<{ i: number; x: number; w: number }>();
  const shown = parts.filter((p) => p.value > 0);
  const total = shown.reduce((t, p) => t + p.value, 0) || 1;

  /** The part under a pointer, from its share of the bar's width. */
  const pick = (e: PointerEvent) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r || !r.width) return;
    const x = Math.min(Math.max(e.clientX - r.left, 0), r.width);
    let end = 0;
    const i = shown.findIndex((p) => (end += p.value / total) * r.width >= x);
    setOn({ i: i < 0 ? shown.length - 1 : i, x, w: r.width });
  };

  // On a phone the tip stays after you lift your finger, until you tap somewhere else.
  useEffect(() => {
    if (!on) return;
    const away = (e: globalThis.PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOn(undefined); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [on]);

  const active = on ? shown[on.i] : undefined;
  // Keep the tip on the card: from the left edge, centred, or from the right edge.
  const side = !on ? 0 : on.x < on.w * 0.3 ? 0 : on.x > on.w * 0.7 ? -100 : -50;
  const bar = (
    <div ref={ref} className={`parts-bar${thin ? ' thin' : ''}${active ? ' dim' : ''}`} role="group" aria-label={label}
      onPointerMove={(e) => { if (e.pointerType === 'mouse' || e.buttons) pick(e); }}
      onPointerDown={(e) => { pick(e); if (e.pointerType !== 'mouse') e.currentTarget.setPointerCapture(e.pointerId); }}
      onPointerLeave={(e) => { if (e.pointerType === 'mouse') setOn(undefined); }}>
      {shown.map((p, i) => (
        <button key={`${p.label}-${i}`} type="button" tabIndex={0} className={on?.i === i ? 'on' : undefined} style={{ flexGrow: p.value }}
          aria-label={`${p.label}${p.note ? `, ${p.note}` : ''}: ${cash(p.value)}`}
          // Keyboard only (Tab to a part): a tap focuses the part too, but the pointer already picked it.
          onFocus={(e) => {
            if (!e.currentTarget.matches(':focus-visible')) return;
            const r = e.currentTarget.parentElement!.getBoundingClientRect(), b = e.currentTarget.getBoundingClientRect();
            setOn({ i, x: b.left - r.left + b.width / 2, w: r.width });
          }}
          onBlur={(e) => { if (e.relatedTarget && !ref.current?.contains(e.relatedTarget as Node)) setOn(undefined); }}>
          <span style={{ background: p.color }} />
        </button>
      ))}
      {active && on && (
        <span role="tooltip" className="pop parts-tip" style={{ left: on.x, transform: `translateX(${side}%)` }}>
          <Dot color={active.color} small /> {active.label}{active.note ? ` · ${active.note}` : ''} <b className="num">{cash(active.value)}</b>
        </span>
      )}
    </div>
  );
  const keys = keyed ? keyOf(shown) : [];
  if (keys.length < 2) return bar;
  return (
    <div className="stack gap-6">
      {bar}
      <div className="key parts-key">
        {keys.map((k) => <span key={k.name}><Dot color={k.color} small />{k.name}<span className="num">{cash(k.value)}</span></span>)}
      </div>
    </div>
  );
}

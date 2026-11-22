import { useState, type PointerEvent } from 'react';
import { tone } from '../core/colors';
import { cash } from '../core/money';
import { Dot } from './components';

/** `key`: a shorter name for the key under a `keyed` bar ("Bills" for "Other bills to come"). */
export interface Part { label: string; value: number; color: string; note?: string; key?: string }

/**
 * One bar split into parts (paid, still to come, put aside, spare). Hover or tap a part to see what it is and
 * its amount underneath; the others fade. Tap it again (or elsewhere on the bar) to hide it.
 * `keyed`: when nothing is tapped, a key underneath names every part with its amount (short labels).
 */
export function PartsBar({ parts, label, keyed }: { parts: Part[]; label: string; keyed?: boolean }) {
  const [on, setOn] = useState<number>();
  const shown = parts.filter((p) => p.value > 0);
  const active = on !== undefined ? shown[on] : undefined;
  const mouse = (e: PointerEvent) => e.pointerType === 'mouse';
  return (
    <div className="stack gap-6">
      <div className={`parts-bar${active ? ' dim' : ''}`} role="group" aria-label={label} onPointerLeave={(e) => mouse(e) && setOn(undefined)}>
        {shown.map((p, i) => (
          <button key={`${p.label}-${i}`} type="button" className={on === i ? 'on' : undefined} style={{ flexGrow: p.value }}
            aria-label={`${p.label} ${cash(p.value)}`} aria-pressed={on === i}
            onPointerEnter={(e) => mouse(e) && setOn(i)} onClick={() => setOn(on === i ? undefined : i)}>
            <span style={{ background: tone(p.color) }} />
          </button>
        ))}
      </div>
      {keyed && !active && shown.length > 1 && (
        <div className="key">
          {shown.map((p, i) => <span key={`${p.label}-${i}`}><Dot color={p.color} small />{p.key ?? p.label} <b className="num">{cash(p.value)}</b></span>)}
        </div>
      )}
      {active && (
        <div className="parts-caption small" aria-live="polite">
          <Dot color={active.color} small />
          <span className="min0">{active.label}{active.note ? <span className="muted"> · {active.note}</span> : null}</span>
          <b className="num">{cash(active.value)}</b>
        </div>
      )}
    </div>
  );
}

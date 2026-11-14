import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { PALETTE, PALETTE_LABELS, sameColor, tone } from '../lib/colors';
import { Icon } from './Icon';

/**
 * The shared building blocks every page is made of. Sizes, colours and spacing all come from the
 * tokens in index.css, so pages only say what something is, not how it looks.
 */

/** A small square of an account's, group's or category's colour, shown beside its name. */
export function Dot({ color, small, style }: { color?: string; small?: boolean; style?: CSSProperties }) {
  return <span className={`dot${small ? ' sm' : ''}`} aria-hidden="true" style={{ background: tone(color || undefined), ...style }} />;
}

/** An account's icon on its colour. */
export function AccIcon({ color, name }: { color?: string; name: string }) {
  return <span className="acc-icon" style={{ background: tone(color) }}><Icon name={name} /></span>;
}

/** The chevron on anything that opens. It turns when its button is aria-expanded. */
export function Chevron({ size = 18 }: { size?: number }) {
  return <span className="chev" aria-hidden="true"><Icon name="down" size={size} /></span>;
}

/** The top of a page: its title, an optional line about it, and its actions on the right. */
export function PageHead({ title, sub, children }: { title: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return (
    <header className="page-head">
      <div className="grow">
        <h1 className="h1">{title}</h1>
        {sub && <p className="page-sub">{sub}</p>}
      </div>
      {children}
    </header>
  );
}

/** Reads and remembers whether something is open, per device (when given a key). */
function useOpen(storageKey: string | undefined, initial: boolean): [boolean, (v: boolean) => void] {
  const [open, setOpen] = useState(() => {
    if (!storageKey) return initial;
    try { const v = localStorage.getItem(storageKey); return v === null ? initial : v === 'open'; } catch { return initial; }
  });
  const set = (v: boolean) => {
    setOpen(v);
    if (storageKey) { try { localStorage.setItem(storageKey, v ? 'open' : 'closed'); } catch { /* ignore */ } }
  };
  return [open, set];
}

/**
 * Details kept behind a click: a title (with an optional note beside it) and a chevron.
 * `wide` puts the chevron at the far right, for a row that fills its card.
 */
export function Disclosure({ title, meta, children, defaultOpen = false, forceOpen, storageKey, wide, ruled, className }: {
  title: ReactNode; meta?: ReactNode; children: ReactNode; defaultOpen?: boolean;
  /** Open regardless of what was chosen (e.g. when there's a problem to show). */
  forceOpen?: boolean;
  /** Remember open or closed on this device under this name. */
  storageKey?: string;
  wide?: boolean; ruled?: boolean; className?: string;
}) {
  const [chosen, setChosen] = useOpen(storageKey, defaultOpen);
  const open = forceOpen || chosen;
  const id = useId();
  return (
    <div className={`disc${ruled ? ' ruled' : ''}${className ? ` ${className}` : ''}`}>
      <button type="button" className={`disc-head${wide ? ' wide' : ''}`} aria-expanded={open} aria-controls={id} onClick={() => setChosen(!open)}>
        <span>{title}{meta !== undefined && meta !== null && meta !== false && <span className="disc-meta"> · {meta}</span>}</span>
        <Chevron size={16} />
      </button>
      {open && <div id={id} className="disc-body">{children}</div>}
    </div>
  );
}

/** A card whose body opens from its heading: for settings and other things looked at now and then. */
export function Section({ title, summary, children, defaultOpen = false, forceOpen, action }: {
  title: string; summary?: ReactNode; children: ReactNode; defaultOpen?: boolean; forceOpen?: boolean; action?: ReactNode;
}) {
  const [chosen, setChosen] = useState(defaultOpen);
  const open = forceOpen || chosen;
  const id = useId();
  return (
    <section className="acc-section">
      <button type="button" className="acc-head" aria-expanded={open} aria-controls={id} onClick={() => setChosen(!open)}>
        <span className="grow">
          <span className="h2 block">{title}</span>
          {!open && summary && <span className="small muted block">{summary}</span>}
        </span>
        {action}
        <Chevron />
      </button>
      {open && <div id={id} className="acc-body">{children}</div>}
    </section>
  );
}

/** Pick a colour from the palette: a button showing the current one, opening the swatches. */
export function ColorPicker({ value, onChange, label = 'Colour' }: { value: string; onChange: (hex: string) => void; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const i = PALETTE.findIndex((c) => sameColor(c, value));
  return (
    <div className="field" ref={ref}>
      <span>{label}</span>
      <button type="button" className="swatch-btn" aria-expanded={open} aria-label={`${label}: ${i >= 0 ? PALETTE_LABELS[i] : 'custom'}. Change`} onClick={() => setOpen(!open)}>
        <Dot color={value} />
        <span className="grow" style={{ color: 'var(--ink)', fontSize: 'var(--fs-md)' }}>{i >= 0 ? PALETTE_LABELS[i] : 'Custom'}</span>
        <Chevron size={16} />
      </button>
      {open && (
        <div className="swatches" role="group" aria-label={`${label} choices`}>
          {PALETTE.map((c, n) => (
            <button key={c} type="button" className="swatch" title={PALETTE_LABELS[n]} aria-label={PALETTE_LABELS[n]} aria-pressed={n === i}
              style={{ background: tone(c) }} onClick={() => { onChange(c); setOpen(false); }} />
          ))}
        </div>
      )}
    </div>
  );
}

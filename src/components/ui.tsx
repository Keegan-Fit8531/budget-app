import { Children, createContext, useCallback, useContext, useEffect, useSyncExternalStore, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { fmtShort, todayISO } from '../lib/dates';
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

/**
 * Something that opens and closes smoothly: it grows from nothing to its full height and fades in (and
 * back again). What's inside is only made the first time it opens, then kept so it can close smoothly.
 * `stacked`: it sits in a stack with a gap (e.g. a card), and takes no room at all while closed.
 */
export function Collapse({ open, children, stacked, id }: { open: boolean; children: ReactNode; stacked?: boolean; id?: string }) {
  const [mounted, setMounted] = useState(open);
  // Follows `open`, a render later when opening: the closed state is drawn first, so the opening animates.
  const [shown, setShown] = useState(open);
  // Fully open: nothing is clipped (focus rings, tooltips).
  const [settled, setSettled] = useState(open);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) { setShown(false); setSettled(false); return; }
    if (!mounted) { setMounted(true); return; }
    if (shown) return;
    void ref.current?.getBoundingClientRect(); // make sure the closed size is laid out before opening
    setShown(true);
  }, [open, mounted, shown]);
  // Settled once the opening has run (--dur-open), whether or not it animated (reduced motion).
  useEffect(() => {
    if (!shown) return;
    const t = setTimeout(() => setSettled(true), 320);
    return () => clearTimeout(t);
  }, [shown]);
  return (
    <div ref={ref} id={id} className={`collapse${stacked ? ' stacked' : ''}${settled ? ' settled' : ''}`} data-open={shown} inert={!shown}>
      <div><div className="collapse-pad">{mounted && children}</div></div>
    </div>
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
 * Inside something already opened (a card's details), sections show straight away under a heading
 * rather than each opening again: one click to see everything, nothing nested.
 */
export const FlatDetails = createContext(false);

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
  const flat = useContext(FlatDetails);
  if (flat) {
    return (
      <section className={`detail-sec${className ? ` ${className}` : ''}`}>
        <h3 className="detail-head">
          <span className="disc-title">{title}</span>
          {meta !== undefined && meta !== null && meta !== false && <span className="detail-meta">{meta}</span>}
        </h3>
        <div className="detail-body">{children}</div>
      </section>
    );
  }
  return (
    <div className={`disc${ruled ? ' ruled' : ''}${className ? ` ${className}` : ''}`}>
      <button type="button" className={`disc-head${wide ? ' wide' : ''}`} aria-expanded={open} aria-controls={id} onClick={() => setChosen(!open)}>
        <span className="disc-title">{title}</span>
        {meta !== undefined && meta !== null && meta !== false && <span className="disc-meta">{meta}</span>}
        <Chevron size={16} />
      </button>
      <Collapse open={open} id={id}><div className="disc-body">{children}</div></Collapse>
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
      <Collapse open={open} id={id}><div className="acc-body">{children}</div></Collapse>
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

const reducedMotion = () => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };

// Pop-ups open on top of each other (a cost over Deposits): Escape closes the top one only.
const openModals: symbol[] = [];

/**
 * A pop-up: the page dims and the panel rises in (from the bottom on a phone), and both go back out
 * when it closes. Closes on Escape or a tap outside. `children` can be a function given `close`, so
 * its own buttons close it with the same animation.
 */
export function Modal({ title, sub, onClose, children, width = 540, actions, className }: {
  title: ReactNode; sub?: ReactNode; onClose: () => void; children: ReactNode | ((close: () => void) => ReactNode);
  width?: number; actions?: ReactNode; className?: string;
}) {
  const [closing, setClosing] = useState(false);
  const id = useId();
  const done = useRef(onClose);
  done.current = onClose;
  const close = useCallback(() => {
    if (reducedMotion()) { done.current(); return; }
    setClosing(true);
    setTimeout(() => done.current(), 180);
  }, []);
  useEffect(() => {
    const me = Symbol('modal');
    openModals.push(me);
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && openModals[openModals.length - 1] === me) { e.stopPropagation(); close(); } };
    document.addEventListener('keydown', key);
    const was = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', key);
      openModals.splice(openModals.indexOf(me), 1);
      if (!openModals.length) document.body.style.overflow = was;
    };
  }, [close]);
  return createPortal(
    <div className={`modal-back${closing ? ' closing' : ''}`} onClick={close}>
      <div className={`modal${className ? ` ${className}` : ''}`} role="dialog" aria-modal="true" aria-labelledby={id} style={{ maxWidth: width }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="grow min0">
            <h2 id={id} className="h2">{title}</h2>
            {sub && <span className="small muted">{sub}</span>}
          </div>
          {actions}
          <button className="icon-btn plain" aria-label="Close" onClick={close}><Icon name="x" /></button>
        </div>
        {typeof children === 'function' ? children(close) : children}
      </div>
    </div>,
    document.body,
  );
}

/** "3h ago", "yesterday", "14 Nov": how long ago something happened, in a word or two. */
export function ago(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const mins = Math.round((now - t) / 60000);
  const day = iso.length <= 10 ? iso : new Date(t).toLocaleDateString('en-CA');
  const today = todayISO();
  if (iso.length > 10 && mins < 1) return 'just now';
  if (iso.length > 10 && mins < 60) return `${mins}m ago`;
  if (day === today) return iso.length > 10 ? `${Math.round(mins / 60)}h ago` : 'today';
  const y = new Date(Date.parse(`${today}T12:00:00`) - 86400000).toLocaleDateString('en-CA');
  if (day === y) return 'yesterday';
  return fmtShort(day);
}

/** Up and down buttons for moving a card, shown while a page is being reordered. */
export function MoveButtons({ name, first, last, onMove }: { name: string; first: boolean; last: boolean; onMove: (dir: -1 | 1) => void }) {
  return (
    <span className="move-btns" role="group" aria-label={`Move ${name}`}>
      <button type="button" className="icon-btn mini" aria-label={`Move ${name} up`} disabled={first} onClick={(e) => { e.stopPropagation(); onMove(-1); }}><Icon name="up" size={16} /></button>
      <button type="button" className="icon-btn mini" aria-label={`Move ${name} down`} disabled={last} onClick={(e) => { e.stopPropagation(); onMove(1); }}><Icon name="down" size={16} /></button>
    </span>
  );
}

/** The page's Reorder / Done button. */
export function ReorderToggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button type="button" className={`btn${on ? ' primary' : ''}`} aria-pressed={on} onClick={() => onChange(!on)}>
      <Icon name={on ? 'check' : 'order'} size={16} /> {on ? 'Done' : 'Reorder'}
    </button>
  );
}

/**
 * Cards sliding to their new place when the order changes. Call `capture()` just before changing the
 * order; once it's drawn, each card (marked with data-flip="its id") glides from where it was.
 */
export function useFlip(order: string) {
  const ref = useRef<HTMLDivElement>(null);
  const before = useRef<Map<string, DOMRect> | null>(null);
  const capture = useCallback(() => {
    const m = new Map<string, DOMRect>();
    ref.current?.querySelectorAll<HTMLElement>('[data-flip]').forEach((n) => m.set(n.dataset.flip!, n.getBoundingClientRect()));
    before.current = m;
  }, []);
  useLayoutEffect(() => {
    const prev = before.current;
    before.current = null;
    if (!prev || reducedMotion()) return;
    ref.current?.querySelectorAll<HTMLElement>('[data-flip]').forEach((n) => {
      const was = prev.get(n.dataset.flip!);
      if (!was) return;
      const now = n.getBoundingClientRect();
      const dx = was.left - now.left, dy = was.top - now.top;
      if (dx || dy) n.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 320, easing: 'cubic-bezier(.22, .8, .24, 1)' });
    });
  }, [order]);
  return { ref, capture };
}

const WIDE = '(min-width: 1180px)';
function useWide(): boolean {
  return useSyncExternalStore((f) => { const m = window.matchMedia(WIDE); m.addEventListener('change', f); return () => m.removeEventListener('change', f); },
    () => window.matchMedia(WIDE).matches);
}

/**
 * Cards two across when there's room: two columns, each its own stack, filled left, right, left… so a
 * card that opens only pushes down the cards below it, and nothing jumps across. One column on a phone.
 */
export function CardColumns({ children, innerRef, className }: { children: ReactNode; innerRef?: React.Ref<HTMLDivElement>; className?: string }) {
  const wide = useWide();
  const list = Children.toArray(children);
  return (
    <div ref={innerRef} className={`card-cols${className ? ` ${className}` : ''}`}>
      {wide
        ? [0, 1].map((c) => <div key={c} className="card-col">{list.filter((_, i) => i % 2 === c)}</div>)
        : <div className="card-col">{list}</div>}
    </div>
  );
}

/** The Details row at the foot of a card. */
export function DetailsToggle({ open, onChange }: { open: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="acct-foot">
      <button type="button" className="disc-head" aria-expanded={open} onClick={() => onChange(!open)}>{open ? 'Hide details' : 'Details'}<Chevron size={16} /></button>
    </div>
  );
}


/** A list that shows its first few rows (5), and 10 more each time "Show more" is tapped. */
export function ShortList({ children, first = 5, step = 10 }: { children: ReactNode; first?: number; step?: number }) {
  const rows = Children.toArray(children);
  const [shown, setShown] = useState(first);
  return (
    <>
      <div>{rows.slice(0, shown)}</div>
      {rows.length > shown && (
        <button type="button" className="btn small ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setShown(shown + step)}>
          Show {Math.min(step, rows.length - shown)} more
        </button>
      )}
    </>
  );
}

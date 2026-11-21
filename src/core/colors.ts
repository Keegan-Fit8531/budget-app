/**
 * Colours for accounts, groups, cost categories and people.
 *
 * A budget stores each colour as a hex. On screen, a colour from the palette is shown through its
 * design token (--pal-*, in index.css), so it has a light and a dark step and matches the rest of
 * the app. Colours saved by earlier versions map onto the nearest token, so nothing saved changes.
 * A colour that isn't from either palette is shown exactly as saved.
 *
 * The first eight are in an order checked for colour-blind separation between neighbours, so the
 * colours handed out first sit safely side by side in a chart. The rest are extra identities for
 * longer lists: fine as a dot beside a name, not for more chart slices.
 */
const SLOTS: { name: string; hex: string; label: string }[] = [
  { name: 'teal', hex: '#1AA89B', label: 'Teal' },
  { name: 'indigo', hex: '#4E59B1', label: 'Indigo' },
  { name: 'moss', hex: '#77A246', label: 'Moss' },
  { name: 'plum', hex: '#884783', label: 'Plum' },
  { name: 'ochre', hex: '#D9A440', label: 'Ochre' },
  { name: 'rose', hex: '#B64466', label: 'Rose' },
  { name: 'sky', hex: '#47A3D3', label: 'Sky' },
  { name: 'clay', hex: '#C06240', label: 'Clay' },
  { name: 'blue', hex: '#3A75BF', label: 'Blue' },
  { name: 'green', hex: '#359658', label: 'Green' },
  { name: 'brick', hex: '#AF3D36', label: 'Brick' },
  { name: 'cyan', hex: '#5DBBC6', label: 'Cyan' },
  { name: 'orange', hex: '#DE8639', label: 'Orange' },
  { name: 'orchid', hex: '#BB7CCA', label: 'Orchid' },
  { name: 'brown', hex: '#7D5B40', label: 'Brown' },
  { name: 'slate', hex: '#667785', label: 'Slate' },
  { name: 'stone', hex: '#A7A49C', label: 'Stone' },
];

export const PALETTE = SLOTS.map((s) => s.hex);
export const PALETTE_LABELS = SLOTS.map((s) => s.label);

/** Colours saved by earlier versions of the app, and the palette colour each one becomes. */
const EARLIER: Record<string, string> = {
  '#14a38b': 'teal', '#9b5de5': 'plum', '#3b82f6': 'blue', '#f59e0b': 'ochre', '#e0527f': 'rose', '#ef4444': 'brick',
  '#84cc16': 'moss', '#06b6d4': 'cyan', '#64748b': 'slate', '#8b5e3c': 'brown', '#22c55e': 'green', '#6366f1': 'indigo',
  '#f97316': 'orange', '#d946ef': 'orchid', '#0ea5e9': 'sky', '#a3a3a3': 'stone', '#e8b23a': 'ochre', '#94a3b8': 'slate',
};

const BY_HEX = new Map(SLOTS.map((s) => [s.hex.toLowerCase(), s.name]));

/** The palette name for a saved colour (new or earlier), if it's one of ours. */
function slotOf(color: string | undefined): string | undefined {
  if (!color) return undefined;
  const c = color.toLowerCase();
  return BY_HEX.get(c) ?? EARLIER[c];
}

/** How a saved colour is shown: its design token when it's from the palette, otherwise as saved. */
export function tone(color: string | undefined): string {
  const s = slotOf(color);
  return s ? `var(--pal-${s})` : color ?? 'var(--muted)';
}

/** True when two saved colours are shown as the same palette colour. */
export function sameColor(a: string | undefined, b: string | undefined): boolean {
  return (slotOf(a) ?? a?.toLowerCase()) === (slotOf(b) ?? b?.toLowerCase());
}

/** The first palette colour not in use yet. */
export function nextColor(used: string[]): string {
  const taken = new Set(used.map((c) => slotOf(c) ?? c.toLowerCase()));
  return SLOTS.find((s) => !taken.has(s.name))?.hex ?? PALETTE[used.length % PALETTE.length];
}

/** The palette colour for the nth item of a list (cost categories, people, bills). */
export function colorAt(i: number): string {
  return `var(--pal-${SLOTS[((i % SLOTS.length) + SLOTS.length) % SLOTS.length].name})`;
}

/** Neutral: "the rest", "to go", "not assigned". Never matches a palette colour. */
export const NEUTRAL_COLOR = 'var(--line)';

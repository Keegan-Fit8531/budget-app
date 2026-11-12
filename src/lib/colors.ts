// Distinct colours for accounts, so no two slices in a pie chart look alike.
export const PALETTE = [
  '#14A38B', // teal
  '#9B5DE5', // purple
  '#3B82F6', // blue
  '#F59E0B', // amber
  '#E0527F', // pink
  '#EF4444', // red
  '#84CC16', // lime
  '#06B6D4', // cyan
  '#64748B', // slate
  '#8B5E3C', // brown
  '#22C55E', // green
  '#6366F1', // indigo
  '#F97316', // orange
  '#D946EF', // fuchsia
  '#0EA5E9', // sky
  '#A3A3A3', // grey
];

/** The first palette colour no account is using yet. */
export function nextColor(used: string[]): string {
  const taken = new Set(used.map((c) => c.toLowerCase()));
  return PALETTE.find((c) => !taken.has(c.toLowerCase())) ?? PALETTE[used.length % PALETTE.length];
}

/** Colour for the "left over" slice — neutral, so it never matches an account. */
export const LEFTOVER_COLOR = '#CBC7DD';

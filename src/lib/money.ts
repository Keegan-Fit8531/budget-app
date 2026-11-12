import type { Cents } from './types';

const nzd = new Intl.NumberFormat('en-NZ', { style: 'currency', currency: 'NZD' });
const nzd0 = new Intl.NumberFormat('en-NZ', { style: 'currency', currency: 'NZD', maximumFractionDigits: 0 });

export function money(c: Cents, opts: { whole?: boolean; sign?: boolean } = {}): string {
  const f = opts.whole ? nzd0 : nzd;
  const s = f.format(Math.abs(c) / 100);
  if (c < 0) return `−${s}`;
  return opts.sign && c > 0 ? `+${s}` : s;
}

/** Split into dollars and cents parts for the big-number display. */
export function moneyParts(c: Cents): { main: string; cents: string } {
  const s = money(c);
  const i = s.lastIndexOf('.');
  return i < 0 ? { main: s, cents: '' } : { main: s.slice(0, i), cents: s.slice(i) };
}

/** Parse "1,234.56" or "$80" into cents; null if invalid. */
export function parseMoney(s: string): Cents | null {
  const clean = s.replace(/[$,\s]/g, '');
  if (!/^-?\d*(\.\d{0,2})?$/.test(clean) || clean === '' || clean === '-') return null;
  return Math.round(parseFloat(clean) * 100);
}

export function centsToInput(c: Cents): string {
  return (c / 100).toFixed(2);
}

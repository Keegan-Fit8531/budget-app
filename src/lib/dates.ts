// All dates are plain ISO calendar dates ("YYYY-MM-DD"), handled in UTC so
// there are no time-zone or daylight-saving surprises.

export type ISODate = string;

export function toDate(iso: ISODate): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function toISO(d: Date): ISODate {
  return d.toISOString().slice(0, 10);
}

export function addDays(iso: ISODate, n: number): ISODate {
  const d = toDate(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return toISO(d);
}

export function diffDays(a: ISODate, b: ISODate): number {
  return Math.round((toDate(b).getTime() - toDate(a).getTime()) / 86400000);
}

/** 0 = Sunday … 6 = Saturday */
export function weekday(iso: ISODate): number {
  return toDate(iso).getUTCDay();
}

export function daysInMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

/** Build a date for a day-of-month, clamping (e.g. the 31st in February → 28th/29th). */
export function dateInMonth(year: number, month0: number, day: number): ISODate {
  const y = year + Math.floor(month0 / 12);
  const m = ((month0 % 12) + 12) % 12;
  return toISO(new Date(Date.UTC(y, m, Math.min(day, daysInMonth(y, m)))));
}

/** Same day of month, n months later (clamped to the month's last day). */
export function addMonths(iso: ISODate, n: number): ISODate {
  const d = toDate(iso);
  return dateInMonth(d.getUTCFullYear(), d.getUTCMonth() + n, d.getUTCDate());
}

/** 1st, 2nd, 3rd, 4th … 21st, 22nd … */
export function ordinal(n: number): string {
  const t = n % 100;
  if (t >= 11 && t <= 13) return `${n}th`;
  return `${n}${n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th'}`;
}

export function todayISO(): ISODate {
  const now = new Date();
  return toISO(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function fmtShort(iso: ISODate): string {
  const d = toDate(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

export function fmtDay(iso: ISODate): string {
  const d = toDate(iso);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

export function monthName(iso: ISODate): string {
  return MONTHS_LONG[toDate(iso).getUTCMonth()];
}

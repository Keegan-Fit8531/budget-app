// ---------------------------------------------------------------------------------------------
// Everything that can go wrong reading a document, each with its own message, so it's clear whether
// it's the key, the credit, today's allowance, the connection or the document.
// ---------------------------------------------------------------------------------------------

export type ReaderErrorKind =
  | 'no_key' | 'bad_key' | 'no_credit' | 'spend_cap' | 'billing_needed' | 'daily_quota' | 'too_fast' | 'overloaded'
  | 'offline' | 'unreachable' | 'timeout' | 'refused_personal' | 'refused' | 'unusable' | 'model_gone' | 'bad_file' | 'cancelled';

export class ReaderError extends Error {
  kind: ReaderErrorKind;
  /** For a daily allowance: when it resets. */
  resetsAt?: Date;
  /** What Google said, shown small under the message. */
  detail?: string;
  constructor(kind: ReaderErrorKind, opts: { resetsAt?: Date; detail?: string } = {}) {
    super(kind);
    this.kind = kind;
    this.resetsAt = opts.resetsAt;
    this.detail = opts.detail;
  }
}

/** Errors where reading on this device is offered instead. */
export const DEVICE_FALLBACK: ReadonlySet<ReaderErrorKind> = new Set(['no_key', 'no_credit', 'spend_cap', 'daily_quota', 'overloaded', 'offline', 'unreachable', 'refused', 'unusable']);

/** When Google's daily allowance resets: midnight Pacific time, shown in NZ time (e.g. "9:00 pm"). */
export function nextPacificMidnight(now: Date = new Date()): Date {
  const hourIn = (d: Date) => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hourCycle: 'h23' }).format(d));
  const t = new Date(now);
  t.setUTCMinutes(0, 0, 0);
  for (let i = 0; i < 50; i++) {
    t.setUTCHours(t.getUTCHours() + 1);
    if (hourIn(t) === 0) return t;
  }
  return t;
}

export function nzTime(d: Date): string {
  return d.toLocaleTimeString('en-NZ', { timeZone: 'Pacific/Auckland', hour: 'numeric', minute: '2-digit' });
}

/** The message for each problem. Every one ends by saying nothing was changed. */
export function errorMessage(e: ReaderError): { title: string; body: string } {
  switch (e.kind) {
    case 'no_key': return { title: 'Set up document reading first.', body: 'Add your Google key in Settings → Reading documents.' };
    case 'bad_key': return { title: 'Google didn’t accept your key.', body: 'It may have been deleted or mistyped. Check it in Settings, or make a new one in AI Studio.' };
    case 'no_credit': return { title: 'Your Google credit has run out.', body: 'Add credit on the AI Studio Billing page.' };
    case 'spend_cap': return { title: 'Your Google spend cap for this month is reached.', body: 'Raise it on the AI Studio Spend page, or wait until next month.' };
    case 'billing_needed': return { title: 'Google needs billing set up on this key’s project.', body: 'See “Set up Google credit” in Settings → Reading documents.' };
    case 'daily_quota': return { title: 'Today’s Google allowance is used up.', body: `It resets at ${nzTime(e.resetsAt ?? nextPacificMidnight())} NZ time.` };
    case 'too_fast': return { title: 'Google’s busy with your last few requests.', body: 'Wait a minute and try again.' };
    case 'overloaded': return { title: 'Google’s reader is busy right now.', body: 'Try again in a few minutes.' };
    case 'offline': return { title: 'You’re offline.', body: 'Connect and try again.' };
    case 'unreachable': return { title: 'Couldn’t reach Google.', body: 'Check your connection and try again.' };
    case 'timeout': return { title: 'That took too long.', body: 'Try again, or use a smaller photo or the PDF.' };
    case 'refused_personal': return { title: 'Google wouldn’t read this because it shows personal details', body: 'such as an IRD or account number. Try a screenshot that crops them out.' };
    case 'refused': return { title: 'Google wouldn’t read this document.', body: 'Try a clearer photo or the PDF.' };
    case 'unusable': return { title: 'Couldn’t make sense of what came back.', body: 'Try again.' };
    case 'model_gone': return { title: 'Google has retired the reading model.', body: 'Change it in Settings → Reading documents → Model.' };
    case 'bad_file': return { title: 'Couldn’t open that file.', body: e.detail ?? 'Try a screenshot, a JPEG photo or the PDF.' };
    case 'cancelled': return { title: 'Stopped.', body: '' };
  }
}

interface GoogleError {
  error?: {
    code?: number | string;
    message?: string;
    status?: string;
    details?: { '@type'?: string; reason?: string; violations?: { quotaId?: string; quotaMetric?: string }[] }[];
  };
}

/**
 * Work out which problem a failed response is. Handles Google's two error styles: the older
 * `{ error: { code: 429, status: "RESOURCE_EXHAUSTED", details: [...] } }` and the newer
 * `{ error: { code: "quota_exceeded", message } }`.
 */
export function classifyHttpError(status: number, body: unknown, now: Date = new Date()): ReaderError {
  const err = (body as GoogleError | null)?.error ?? {};
  const code = typeof err.code === 'string' ? err.code : '';
  const st = err.status ?? '';
  const msg = err.message ?? '';
  const reasons = (err.details ?? []).map((d) => d.reason ?? '').join(' ');
  const quotaIds = (err.details ?? []).flatMap((d) => (d.violations ?? []).map((v) => `${v.quotaId ?? ''} ${v.quotaMetric ?? ''}`)).join(' ');
  const detail = msg || undefined;
  const all = `${code} ${st} ${reasons} ${quotaIds} ${msg}`;

  if (status === 401 || code === 'authentication' || /API_KEY_INVALID|API key not valid|API key expired/i.test(all)) return new ReaderError('bad_key', { detail });
  if (status === 402 || code === 'payment_required') return new ReaderError('no_credit', { detail });
  if (status === 404 || code === 'model_not_found') return new ReaderError('model_gone', { detail });
  if (status === 429 || st === 'RESOURCE_EXHAUSTED') {
    if (/spend(ing)? cap|tier cap/i.test(msg)) return new ReaderError('spend_cap', { detail });
    if (code === 'quota_exceeded' || /PerDay|per day|daily/i.test(`${quotaIds} ${msg}`)) return new ReaderError('daily_quota', { resetsAt: nextPacificMidnight(now), detail });
    return new ReaderError('too_fast', { detail });
  }
  if (code === 'failed_precondition' || st === 'FAILED_PRECONDITION' || /billing/i.test(msg)) return new ReaderError('billing_needed', { detail });
  if (status === 403 || code === 'permission_denied') return new ReaderError('bad_key', { detail });
  if (status === 504 || code === 'deadline_exceeded') return new ReaderError('timeout', { detail });
  if (status >= 500) return new ReaderError('overloaded', { detail });
  // 400 for the document itself (an unsupported or damaged file).
  return new ReaderError('refused', { detail });
}

/** A response that came back but was blocked, by Google's reason codes. */
export function blockedError(reason: string | undefined): ReaderError | undefined {
  if (!reason) return undefined;
  const r = reason.toUpperCase();
  if (r === 'SPII') return new ReaderError('refused_personal');
  if (['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'RECITATION', 'IMAGE_SAFETY', 'LANGUAGE', 'OTHER', 'CONTENT_BLOCKED'].includes(r)) return new ReaderError('refused', { detail: reason });
  return undefined;
}

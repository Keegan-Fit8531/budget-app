import { fromStatementRows, joinReads } from '../csv';
import { todayISO } from '../dates';
import { GEMINI_BASE, TIMEOUT_MS } from './config';
import { blockedError, classifyHttpError, ReaderError } from './errors';
import { instructions, RESPONSE_SCHEMA } from './prompt';
import type { Extraction, PreparedFile, Provider, ProviderOptions, RawKiwiSaver, RawStatement, ReadContext } from './types';

// ---------------------------------------------------------------------------------------------
// Google's Gemini API, called straight from the browser with plain fetch (no SDK). The key is sent
// in a header, never in the web address, so it doesn't end up in logs.
// ---------------------------------------------------------------------------------------------

export interface GenerateResponse {
  promptFeedback?: { blockReason?: string };
  candidates?: { finishReason?: string; content?: { parts?: { text?: string; thought?: boolean }[] } }[];
}

export async function call(opts: ProviderOptions, body: unknown, fetchImpl: typeof fetch = fetch): Promise<GenerateResponse> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), TIMEOUT_MS);
  const onCancel = () => timeout.abort();
  opts.signal?.addEventListener('abort', onCancel);
  let res: Response;
  try {
    res = await fetchImpl(`${GEMINI_BASE}/models/${encodeURIComponent(opts.model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': opts.key },
      body: JSON.stringify(body),
      signal: timeout.signal,
    });
  } catch {
    if (opts.signal?.aborted) throw new ReaderError('cancelled');
    if (timeout.signal.aborted) throw new ReaderError('timeout');
    throw new ReaderError(typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'unreachable');
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onCancel);
  }
  let json: unknown = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) throw classifyHttpError(res.status, json);
  return (json ?? {}) as GenerateResponse;
}

/** The kinds the form can come back as ("account" is a bank account, turned into "transactions"). */
const KINDS = ['payslip', 'statement', 'account', 'balances', 'afterpay', 'kiwisaver', 'unknown'];

type RawRow = { date?: string; description?: string; amount?: string; balance?: string };
interface RawAccount {
  number?: string;
  closingBalance?: { amount?: string };
  closingDate?: string;
  /** One line each, "date|description|amount|balance" (or, from an older form, an object). */
  rows?: (string | RawRow)[];
}

/** "2026-06-10|Pizza Hut Ho|-8.49|342.51" → its parts (a "|" in the description is kept). */
export function splitRow(row: string | RawRow): RawRow {
  if (typeof row !== 'string') return row;
  const parts = row.split('|').map((x) => x.trim());
  if (parts.length < 3) return { description: row };
  const withBalance = parts.length >= 4;
  return {
    date: parts[0],
    description: parts.slice(1, withBalance ? -2 : -1).join(' | '),
    amount: parts[parts.length - (withBalance ? 2 : 1)],
    ...(withBalance && parts[parts.length - 1] ? { balance: parts[parts.length - 1] } : {}),
  };
}

/** The form makes every field answered, with null for what isn't shown; drop those so it's the same as a field left out. */
function dropNulls(v: unknown): unknown {
  if (Array.isArray(v)) return v.filter((x) => x !== null).map(dropNulls);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null).map(([k, x]) => [k, dropNulls(x)]));
  return v;
}

/** Turn the model's reply into the form, or say why it can't be used. A bank account's rows become transactions, like an export's. */
export function parseReply(r: GenerateResponse, today = todayISO()): Extraction {
  const blocked = blockedError(r.promptFeedback?.blockReason) ?? blockedError(r.candidates?.[0]?.finishReason);
  if (blocked) throw blocked;
  const text = (r.candidates?.[0]?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? '').join('').trim();
  if (!text) throw new ReaderError('unusable', { detail: r.candidates?.[0]?.finishReason });
  let out: unknown;
  try { out = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { throw new ReaderError('unusable', { detail: 'Not JSON' }); }
  const raw = dropNulls(out) as Omit<Extraction, 'kind'> & { kind: string; account?: RawAccount };
  if (!raw || typeof raw !== 'object' || !KINDS.includes(raw.kind)) throw new ReaderError('unusable', { detail: 'No document kind' });
  if (raw.kind === 'account') {
    const a = raw.account ?? {};
    const transactions = fromStatementRows((a.rows ?? []).map(splitRow), { today, number: a.number, closing: { amount: a.closingBalance?.amount, date: a.closingDate } });
    return { kind: 'transactions', transactions, ...(raw.notes ? { notes: raw.notes } : {}) };
  }
  delete raw.account;
  return raw as Extraction;
}

/** Pages of a long PDF's text read in one request, and requests sent at once (a year of statements in one or two rounds). */
export const PAGES_AT_ONCE = 4;
export const REQUESTS_AT_ONCE = 16;

const wait = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  const done = () => { clearTimeout(t); signal?.removeEventListener('abort', done); resolve(); };
  const t = setTimeout(done, ms);
  signal?.addEventListener('abort', done);
});

/** Parts in flight across every document being read (several chosen at once share them). */
let inFlight = 0;
const waiting: (() => void)[] = [];
async function slot(): Promise<() => void> {
  if (inFlight >= REQUESTS_AT_ONCE) await new Promise<void>((r) => waiting.push(r));
  inFlight++;
  return () => { inFlight--; waiting.shift()?.(); };
}

/** The last line with a year in it before some pages (e.g. "Statement period 10 Jun 2026 - 09 Sep 2026"), for dates printed without years. */
function lastDated(pages: string[]): string | undefined {
  const lines = pages.join('\n').split('\n').map((l) => l.trim().replace(/\s{2,}/g, ' ')).filter((l) => /\b20\d\d\b/.test(l));
  const line = [...lines].reverse().find((l) => /period|statement|as at/i.test(l)) ?? lines[lines.length - 1];
  return line?.slice(0, 140);
}

/** Reads of a long document's parts (a few pages each), as one. */
export function mergeReads(list: Extraction[]): Extraction {
  const known = list.filter((x) => x.kind !== 'unknown');
  if (!known.length) return list[0] ?? { kind: 'unknown' };
  const count = (k: string) => known.filter((x) => x.kind === k).length;
  const kind = known.map((x) => x.kind).sort((a, b) => count(b) - count(a))[0];
  const same = known.filter((x) => x.kind === kind);
  const notes = [...new Set(list.map((x) => x.notes).filter(Boolean))].join(' ');
  const withNotes = (e: Extraction): Extraction => (notes ? { ...e, notes } : e);
  if (kind === 'transactions') return withNotes({ kind, transactions: joinReads(same.flatMap((x) => (x.transactions ? [x.transactions] : []))) });
  if (kind === 'afterpay') return withNotes({ kind, afterpay: { orders: same.flatMap((x) => x.afterpay?.orders ?? []) } });
  if (kind === 'balances') {
    const first = same.find((x) => x.balances)?.balances ?? {};
    return withNotes({ kind, balances: { ...first, accounts: same.flatMap((x) => x.balances?.accounts ?? []) } });
  }
  if (kind === 'kiwisaver') {
    // The first part to give a figure gives it; funds are listed once each.
    const k: RawKiwiSaver = {};
    for (const x of same) {
      for (const [key, v] of Object.entries(x.kiwisaver ?? {}) as [keyof RawKiwiSaver, unknown][]) {
        if (key !== 'funds' && k[key] === undefined && v !== undefined) (k as Record<string, unknown>)[key] = v;
      }
    }
    const funds = same.flatMap((x) => x.kiwisaver?.funds ?? []);
    k.funds = funds.filter((f, i) => funds.findIndex((g) => (g.name ?? '').toLowerCase() === (f.name ?? '').toLowerCase()) === i);
    return withNotes({ kind, kiwisaver: k });
  }
  if (kind === 'statement') {
    // A statement's figures are on its first page or two; its plans can run on.
    const s: RawStatement = {};
    for (const x of same) {
      for (const [k, v] of Object.entries(x.statement ?? {}) as [keyof RawStatement, unknown][]) {
        if (k === 'plans' || k === 'purchases' || k === 'paymentsShown') continue;
        if (s[k] === undefined && v !== undefined) (s as Record<string, unknown>)[k] = v;
      }
    }
    s.plans = same.flatMap((x) => x.statement?.plans ?? []);
    s.purchases = same.flatMap((x) => x.statement?.purchases ?? []);
    return withNotes({ kind, statement: s });
  }
  return withNotes(same[0]);
}

function request(ctx: ReadContext, document: unknown[]) {
  return {
    systemInstruction: { parts: [{ text: instructions(ctx.today) }] },
    contents: [{
      role: 'user',
      parts: [...document, { text: `Read this document. Today is ${ctx.today}. The debts and plans to choose from:\n${JSON.stringify(ctx.debts)}` }],
    }],
    generationConfig: {
      responseFormat: { text: { mimeType: 'APPLICATION_JSON', schema: RESPONSE_SCHEMA } },
      // A bank statement page lists up to about 40 transactions.
      maxOutputTokens: 16384,
    },
  };
}

export function geminiProvider(fetchImpl: typeof fetch = (...a) => fetch(...a)): Provider {
  return {
    id: 'gemini',
    async read(file: PreparedFile, ctx: ReadContext, opts: ProviderOptions): Promise<Extraction> {
      return parseReply(await call(opts, request(ctx, [{ inlineData: { mimeType: file.mimeType, data: file.base64 } }]), fetchImpl), ctx.today);
    },
    /** A long PDF, as its text: read a few pages at a time (three requests at once), then put together. */
    async readText(pages: string[], ctx: ReadContext, opts: ProviderOptions, onPart?: (done: number, total: number) => void): Promise<Extraction> {
      const parts: { from: number; to: number; text: string; before?: string }[] = [];
      for (let i = 0; i < pages.length; i += PAGES_AT_ONCE) {
        const to = Math.min(pages.length, i + PAGES_AT_ONCE);
        parts.push({ from: i + 1, to, before: lastDated(pages.slice(0, i)), text: pages.slice(i, to).map((p, k) => `--- Page ${i + k + 1} ---\n${p}`).join('\n\n') });
      }
      const results: Extraction[] = [];
      let next = 0;
      let done = 0;
      let failed = false;
      const work = async () => {
        while (next < parts.length && !failed) {
          const k = next++;
          const p = parts[k];
          const intro = `Pages ${p.from} to ${p.to} of ${pages.length} of a PDF, as its text (the spacing keeps the columns lined up).${p.before ? ` Earlier in the document: “${p.before}”.` : ''}`;
          // So many at once can be more than Google takes in a minute: wait a moment and try that part again.
          for (let attempt = 1; ; attempt++) {
            try {
              const release = await slot();
              try {
                results[k] = parseReply(await call(opts, request(ctx, [{ text: `${intro}\n\n${p.text}` }]), fetchImpl), ctx.today);
              } finally { release(); }
              break;
            } catch (e) {
              const busy = e instanceof ReaderError && (e.kind === 'too_fast' || e.kind === 'overloaded');
              if (!busy || attempt >= 6 || failed) { failed = true; throw e; }
              await wait(1500 * attempt * attempt, opts.signal);
              if (opts.signal?.aborted) { failed = true; throw new ReaderError('cancelled'); }
            }
          }
          onPart?.(++done, parts.length);
        }
      };
      await Promise.all(Array.from({ length: Math.min(REQUESTS_AT_ONCE, parts.length) }, work));
      return mergeReads(results);
    },
    async test(opts: ProviderOptions): Promise<void> {
      await call(opts, { contents: [{ role: 'user', parts: [{ text: 'Reply with the word OK.' }] }], generationConfig: { maxOutputTokens: 16 } }, fetchImpl);
    },
  };
}

import { GEMINI_BASE, TIMEOUT_MS } from './config';
import { blockedError, classifyHttpError, ReaderError } from './errors';
import { instructions, RESPONSE_SCHEMA } from './prompt';
import type { DocKind, Extraction, PreparedFile, Provider, ProviderOptions, ReadContext } from './types';

// ---------------------------------------------------------------------------------------------
// Google's Gemini API, called straight from the browser with plain fetch (no SDK). The key is sent
// in a header, never in the web address, so it doesn't end up in logs.
// ---------------------------------------------------------------------------------------------

interface GenerateResponse {
  promptFeedback?: { blockReason?: string };
  candidates?: { finishReason?: string; content?: { parts?: { text?: string; thought?: boolean }[] } }[];
}

async function call(opts: ProviderOptions, body: unknown, fetchImpl: typeof fetch = fetch): Promise<GenerateResponse> {
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

const KINDS: DocKind[] = ['payslip', 'statement', 'afterpay', 'unknown'];

/** Turn the model's reply into the form, or say why it can't be used. */
export function parseReply(r: GenerateResponse): Extraction {
  const blocked = blockedError(r.promptFeedback?.blockReason) ?? blockedError(r.candidates?.[0]?.finishReason);
  if (blocked) throw blocked;
  const text = (r.candidates?.[0]?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? '').join('').trim();
  if (!text) throw new ReaderError('unusable', { detail: r.candidates?.[0]?.finishReason });
  let out: unknown;
  try { out = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { throw new ReaderError('unusable', { detail: 'Not JSON' }); }
  const ex = out as Extraction;
  if (!ex || typeof ex !== 'object' || !KINDS.includes(ex.kind)) throw new ReaderError('unusable', { detail: 'No document kind' });
  return ex;
}

export function geminiProvider(fetchImpl: typeof fetch = (...a) => fetch(...a)): Provider {
  return {
    id: 'gemini',
    async read(file: PreparedFile, ctx: ReadContext, opts: ProviderOptions): Promise<Extraction> {
      const body = {
        systemInstruction: { parts: [{ text: instructions(ctx.today) }] },
        contents: [{
          role: 'user',
          parts: [
            { inlineData: { mimeType: file.mimeType, data: file.base64 } },
            { text: `Read this document. Today is ${ctx.today}. The debts and plans to choose from:\n${JSON.stringify(ctx.debts)}` },
          ],
        }],
        generationConfig: {
          responseFormat: { text: { mimeType: 'APPLICATION_JSON', schema: RESPONSE_SCHEMA } },
          maxOutputTokens: 8192,
        },
      };
      return parseReply(await call(opts, body, fetchImpl));
    },
    async test(opts: ProviderOptions): Promise<void> {
      await call(opts, { contents: [{ role: 'user', parts: [{ text: 'Reply with the word OK.' }] }], generationConfig: { maxOutputTokens: 16 } }, fetchImpl);
    },
  };
}

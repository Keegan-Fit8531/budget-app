import { describe, expect, it } from 'vitest';
import { toCents, validDate } from './check/figures';
import { toDraft } from './check/toDraft';
import { classifyHttpError, nextPacificMidnight, nzTime, ReaderError } from './errors';
import { geminiProvider, parseReply } from './gemini';
import { prepareFile } from './prepare';
import { buildContext, RESPONSE_SCHEMA } from './prompt';
import { debtBudget, seq } from '../../testing/fixtures';

// ---------------------------------------------------------------------------------------------
// Reading documents with Google's Gemini. The AI is always faked here: these check what the app does
// with an answer (the checks, the changes, no doubling, Undo), and how each error is told apart.
// ---------------------------------------------------------------------------------------------

describe('reading documents: figures, dates and errors', () => {
  it('reads amounts as printed, and refuses anything that isn’t a sensible amount or a real date', () => {
    expect(toCents('1,240.50')).toEqual({ cents: 124050, credit: false });
    expect(toCents('$12.40 CR')).toEqual({ cents: 1240, credit: true });
    expect(toCents('-5.00')).toEqual({ cents: 500, credit: true });
    expect(toCents('')).toBeUndefined();
    expect([toCents('12.4.5'), toCents('about $40'), toCents('2000000.00')]).toEqual([null, null, null]);
    expect([validDate('2026-11-03'), validDate('2026-02-30'), validDate('03/11/2026'), validDate('1999-01-01')]).toEqual(['2026-11-03', undefined, undefined, undefined]);
  });

  it('tells each of Google’s errors apart', () => {
    const kind = (status: number, body: unknown) => classifyHttpError(status, body).kind;
    expect(kind(401, {})).toBe('bad_key');
    expect(kind(400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.', details: [{ reason: 'API_KEY_INVALID' }] } })).toBe('bad_key');
    expect(kind(402, { error: { code: 'payment_required', message: 'Your Prepay credit balance is depleted.' } })).toBe('no_credit');
    expect(kind(404, { error: { code: 404, status: 'NOT_FOUND', message: 'models/gemini-1.0 is not found' } })).toBe('model_gone');
    expect(kind(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] } })).toBe('daily_quota');
    expect(kind(429, { error: { code: 'quota_exceeded', message: 'You have exceeded your daily quota.' } })).toBe('daily_quota');
    expect(kind(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', details: [{ violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel' }] }] } })).toBe('too_fast');
    expect(kind(429, { error: { code: 429, message: 'You have exceeded your monthly spending cap.' } })).toBe('spend_cap');
    expect(kind(400, { error: { code: 'failed_precondition', message: 'Billing is not enabled.' } })).toBe('billing_needed');
    expect(kind(403, { error: { code: 403, status: 'PERMISSION_DENIED' } })).toBe('bad_key');
    expect(kind(503, {})).toBe('overloaded');
    expect(kind(504, {})).toBe('timeout');
    // The daily allowance resets at midnight Pacific time: 9 pm in NZ in November.
    expect(nzTime(nextPacificMidnight(new Date('2026-11-16T03:00:00Z')))).toMatch(/^9:00\spm$/i);
  });

  const reply = (text: string, extra: object = {}) => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'thinking…', thought: true }, { text }] } }], ...extra });

  it('a reply is used only if it’s the form; a blocked or empty one says why', () => {
    expect(parseReply(reply('{"kind":"payslip","payslip":{"payDay":"2026-11-19"}}')).kind).toBe('payslip');
    expect(() => parseReply(reply('not json'))).toThrow(ReaderError);
    expect(() => parseReply(reply('{"kind":"recipe"}'))).toThrowError(expect.objectContaining({ kind: 'unusable' }));
    expect(() => parseReply({ candidates: [{ finishReason: 'SPII' }] })).toThrowError(expect.objectContaining({ kind: 'refused_personal' }));
    expect(() => parseReply({ promptFeedback: { blockReason: 'SAFETY' } })).toThrowError(expect.objectContaining({ kind: 'refused' }));
    expect(() => parseReply({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }] })).toThrowError(expect.objectContaining({ kind: 'unusable' }));
  });

  it('the form makes Gemini answer every field (null when not shown), and the nulls are dropped again', () => {
    // With optional fields the real Gemini sometimes stopped early: a payslip with only its gross pay,
    // a Gem statement with no balance. Every object in the form must list all its fields as required.
    const walk = (s: Record<string, unknown>, at: string) => {
      const props = s.properties as Record<string, Record<string, unknown>> | undefined;
      if (props) {
        expect(new Set(s.required as string[]), at).toEqual(new Set(Object.keys(props)));
        for (const [k, v] of Object.entries(props)) walk(v, `${at}.${k}`);
      }
      if (s.items) walk(s.items as Record<string, unknown>, `${at}[]`);
    };
    walk(RESPONSE_SCHEMA, 'form');
    const ex = parseReply(reply(JSON.stringify({
      kind: 'statement', payslip: null, afterpay: null, notes: null,
      statement: { debtId: null, balance: { amount: '3,084.17', label: 'Closing balance' }, limit: null, plans: [{ planId: null, remaining: { amount: '870.00', label: 'Plan balance' }, ends: '2027-03-21' }], purchases: [], paymentsShown: [] },
    })));
    expect(ex).toEqual({ kind: 'statement', statement: { balance: { amount: '3,084.17', label: 'Closing balance' }, plans: [{ remaining: { amount: '870.00', label: 'Plan balance' }, ends: '2027-03-21' }], purchases: [], paymentsShown: [] } });
    // And it still checks the same as a reply that left those fields out.
    const d = toDraft(ex, debtBudget(), 'gemini', seq());
    expect(d.statement).toMatchObject({ debtId: '', limit: { value: '' }, plans: [{ planId: '', ends: '2027-03-21' }] });
  });

  it('sends the key in a header (never in the address) with the document and the list of debts', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Response.json({ candidates: [{ content: { parts: [{ text: '{"kind":"unknown"}' }] } }] });
    }) as unknown as typeof fetch;
    const ctx = buildContext(debtBudget(), '2026-11-16');
    expect(ctx.debts.find((d) => d.id === 'studentloan')).toMatchObject({ studentLoan: true });
    // A card plan goes by name only: given its expiry and balance, Gemini copied them over the
    // statement's (or misread the printed date towards them). The app matches plans by expiry itself.
    expect(ctx.debts.find((d) => d.id === 'gem')!.plans[0]).toEqual({ id: 'g1', name: 'Purchases Jun – Jul 2026', type: 'interest-free' });
    // Afterpay orders have nothing printed to match on, so they keep their dates and amounts.
    expect(ctx.debts.find((d) => d.id === 'afterpay')!.plans[1]).toMatchObject({ id: 'ap-2', purchaseDate: '2026-10-08', total: '24.66', nextInstalment: { date: '2026-11-19', amount: '6.17' } });
    await geminiProvider(fake).read({ name: 'a.jpg', mimeType: 'image/jpeg', base64: 'AAAA', bytes: 3 }, ctx, { key: 'k-123', model: 'gemini-3.5-flash-lite' });
    expect(calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');
    expect(calls[0].url).not.toContain('k-123');
    expect((calls[0].init.headers as Record<string, string>)['x-goog-api-key']).toBe('k-123');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.contents[0].parts[0]).toEqual({ inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } });
    expect(body.contents[0].parts[1].text).toContain('"g1"');
    expect(body.generationConfig.responseFormat).toEqual({ text: { mimeType: 'APPLICATION_JSON', schema: RESPONSE_SCHEMA } });
    // A failed call becomes the right error.
    const failing = (async () => new Response(JSON.stringify({ error: { code: 'payment_required' } }), { status: 402 })) as unknown as typeof fetch;
    await expect(geminiProvider(failing).read({ name: 'a.pdf', mimeType: 'application/pdf', base64: 'AA', bytes: 1 }, ctx, { key: 'k', model: 'm' })).rejects.toMatchObject({ kind: 'no_credit' });
  });

  it('a photo this browser can’t redraw (HEIC outside Safari) is sent as it is, which Google reads', async () => {
    // There's no canvas here, so every photo takes the "can't redraw" path, as HEIC does in Chrome.
    const heic = await prepareFile(new File([new Uint8Array([1, 2, 3])], 'IMG_0412.HEIC', { type: '' }));
    expect(heic).toMatchObject({ mimeType: 'image/heic', base64: 'AQID', bytes: 3 });
    expect((await prepareFile(new File([new Uint8Array([1])], 'photo.heif', { type: 'image/heif' }))).mimeType).toBe('image/heif');
    await expect(prepareFile(new File([new Uint8Array([1])], 'scan.tiff', { type: 'image/tiff' }))).rejects.toMatchObject({ kind: 'bad_file' });
  });
});

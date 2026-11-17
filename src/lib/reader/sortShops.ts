import { CATEGORY_LABEL, otherShops, type SpendCategory, type UnsortedShop } from '../spending';
import type { Budget } from '../types';
import { call } from './gemini';
import { modelOf, readReaderConfig } from './config';
import { ReaderError } from './errors';

// ---------------------------------------------------------------------------------------------
// Sorting the shops the app's own rules can't place (they'd go in Other). Gemini gets only the shop
// names, one example description each and how many purchases there were: no amounts, dates or
// accounts. Its guesses are kept apart from your own choices, which always win.
// ---------------------------------------------------------------------------------------------

/** At most this many shops a request, and requests a run, so a run stays small. */
const PER_CALL = 150;
const MAX_CALLS = 4;

const CHOICES: SpendCategory[] = Object.keys(CATEGORY_LABEL) as SpendCategory[];

export const SORT_INSTRUCTIONS = `You sort shop names from a New Zealand bank or card statement into spending categories for a budgeting app.
For each shop, choose the one category it most likely is, from: ${CHOICES.map((c) => `${c} (${CATEGORY_LABEL[c]})`).join(', ')}.
"transfers" is only for money moved between the person's own accounts (their account names are given) or paying off their own card: it isn't counted as spending. Rent or board paid to a landlord or property manager is "bills".
Use what you know of New Zealand shops and chains. A person's name or a transfer you can't place is "other". Only say "other" when you really can't tell.
Answer with every shop given, using its name exactly as given.`;

const SCHEMA = {
  type: 'OBJECT',
  properties: { shops: { type: 'ARRAY', items: { type: 'OBJECT', properties: { shop: { type: 'STRING' }, category: { type: 'STRING', enum: CHOICES } }, required: ['shop', 'category'] } } },
  required: ['shops'],
};

/** All purchases, across cards and accounts. */
export const allTxns = (b: Budget) => [...(b.debts ?? []).flatMap((d) => d.transactions ?? []), ...Object.values(b.accountTransactions ?? {}).flat()];

/** The lines sent for some shops. */
export const sortInput = (shops: UnsortedShop[]) => shops.map((s) => `${s.shop} | ${s.example.replace(/\|/g, ' ')} | ×${s.count}`).join('\n');

/** Read Gemini's answer: shop (lower case) → category, only for shops that were asked about. */
export function parseSorted(text: string | undefined, asked: UnsortedShop[]): Record<string, SpendCategory> {
  const out: Record<string, SpendCategory> = {};
  const names = new Map(asked.map((s) => [s.shop.toLowerCase(), s.shop]));
  try {
    const body = JSON.parse(text ?? '') as { shops?: { shop?: string; category?: string }[] };
    for (const x of body.shops ?? []) {
      const key = (x.shop ?? '').toLowerCase().trim();
      if (names.has(key) && CHOICES.includes(x.category as SpendCategory)) out[key] = x.category as SpendCategory;
    }
  } catch { /* nothing usable */ }
  return out;
}

/** Guess categories for the shops still in Other. Returns the guesses (shop → category); throws a ReaderError when it can't. */
export async function sortShops(b: Budget, fetchImpl?: typeof fetch): Promise<Record<string, SpendCategory>> {
  const conf = readReaderConfig();
  if (!conf) throw new ReaderError('no_key');
  const shops = otherShops(allTxns(b), b).slice(0, PER_CALL * MAX_CALLS);
  const out: Record<string, SpendCategory> = {};
  for (let i = 0; i < shops.length; i += PER_CALL) {
    const batch = shops.slice(i, i + PER_CALL);
    const r = await call({ key: conf.key, model: modelOf(conf) }, {
      systemInstruction: { parts: [{ text: SORT_INSTRUCTIONS }] },
      contents: [{ role: 'user', parts: [{ text: `Their own accounts: ${b.accounts.map((a) => a.name).join(', ')}.\n\nShops (name | an example description | how many purchases):\n${sortInput(batch)}` }] }],
      generationConfig: { responseFormat: { text: { mimeType: 'APPLICATION_JSON', schema: SCHEMA } }, maxOutputTokens: 8192 },
    }, fetchImpl);
    const text = r.candidates?.[0]?.content?.parts?.filter((p) => !p.thought).map((p) => p.text ?? '').join('');
    const got = parseSorted(text, batch);
    // A shop it skipped is noted as "other", so it isn't sent again and again.
    for (const s of batch) out[s.shop.toLowerCase()] = got[s.shop.toLowerCase()] ?? 'other';
  }
  return out;
}

import { CATEGORY_LABEL, otherShops, type SpendCategory, type UnsortedShop } from '../spending';
import type { Budget } from '../types';
import { call } from './gemini';
import { modelOf, readReaderConfig } from './config';
import { ReaderError } from './errors';

// ---------------------------------------------------------------------------------------------
// Sorting the shops the app's own rules can't place (they'd go in Other). Gemini gets the shop names,
// one example description each, how many purchases there were and their smallest and largest
// amounts (a $12 to $90 shop is likely fuel, not a café), plus shops you've sorted yourself as
// examples. No dates, balances or account numbers. It looks shops up with Google Search, so a local
// petrol station isn't taken for a café from its name. Its guesses are kept apart from your own
// choices, which always win.
// ---------------------------------------------------------------------------------------------

/** At most this many shops a request, and requests a run, so a run stays small. */
const PER_CALL = 40;
const MAX_CALLS = 10;
/** Your own choices sent as examples, at most. */
const EXAMPLES = 40;

const CHOICES: SpendCategory[] = Object.keys(CATEGORY_LABEL) as SpendCategory[];

export const SORT_INSTRUCTIONS = `You sort shop names from a New Zealand bank or card statement into spending categories for a budgeting app.
For each shop, choose the one category it most likely is, from: ${CHOICES.map((c) => `${c} (${CATEGORY_LABEL[c]})`).join(', ')}.
Names are cut short by the bank and often end with the suburb or town (e.g. "Tasman Epsom Auckland" is a business in Epsom, Auckland). Don't guess from the words in the name: when you aren't sure what a business is, look it up with Google Search using its name and place, and go by what it actually is.
Petrol and fuel stations (Z, BP, Mobil, Gull, Waitomo, NPD, Tasman, U-Go, Allied and independents) are "transport", even when they sell food and coffee.
The smallest and largest purchase amounts help: a café is usually $5 to $30 a time; fuel is often $20 to $120.
"transfers" is only for money moved between the person's own accounts (their account names are given) or paying off their own card: it isn't counted as spending. Rent or board paid to a landlord or property manager is "bills".
A person's name or a transfer you can't place is "other". Only say "other" when you really can't tell, even after searching.
Answer with every shop given, using its name exactly as given, and a few words on what the business is.`;

const SCHEMA = {
  type: 'OBJECT',
  properties: { shops: { type: 'ARRAY', items: { type: 'OBJECT', properties: { shop: { type: 'STRING' }, what: { type: 'STRING' }, category: { type: 'STRING', enum: CHOICES } }, required: ['shop', 'what', 'category'] } } },
  required: ['shops'],
};

/** All purchases, across cards and accounts. */
export const allTxns = (b: Budget) => [...(b.debts ?? []).flatMap((d) => d.transactions ?? []), ...Object.values(b.accountTransactions ?? {}).flat()];

/** The lines sent for some shops. */
export const sortInput = (shops: UnsortedShop[]) => shops.map((s) => `${s.shop} | ${s.example.replace(/\|/g, ' ')} | ×${s.count} | ${s.min === s.max ? dollars(s.min) : `${dollars(s.min)} to ${dollars(s.max)}`}`).join('\n');
const dollars = (c: number) => `$${Math.round(c / 100)}`;

/** Shops you've put in a category yourself, as examples of how you sort. */
export const examplesInput = (b: Pick<Budget, 'shopCategories'>) =>
  Object.entries(b.shopCategories ?? {}).slice(-EXAMPLES).map(([shop, c]) => `${shop} → ${c}`).join('\n');

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

/**
 * Guess categories for the shops still in Other. With `again`, it also checks the guesses it made
 * before (never your own choices). Returns the guesses (shop → category); throws a ReaderError when it can't.
 */
export async function sortShops(b: Budget, fetchImpl?: typeof fetch, again = false): Promise<Record<string, SpendCategory>> {
  const conf = readReaderConfig();
  if (!conf) throw new ReaderError('no_key');
  const shops = otherShops(allTxns(b), b, again).slice(0, PER_CALL * MAX_CALLS);
  const examples = examplesInput(b);
  const out: Record<string, SpendCategory> = {};
  for (let i = 0; i < shops.length; i += PER_CALL) {
    const batch = shops.slice(i, i + PER_CALL);
    const r = await call({ key: conf.key, model: modelOf(conf) }, {
      systemInstruction: { parts: [{ text: SORT_INSTRUCTIONS }] },
      contents: [{ role: 'user', parts: [{ text: [
        `Their own accounts: ${b.accounts.map((a) => a.name).join(', ')}.`,
        examples && `Shops they've sorted themselves (follow how they sort):\n${examples}`,
        `Shops (name | an example description | how many purchases | smallest to largest purchase):\n${sortInput(batch)}`,
      ].filter(Boolean).join('\n\n') }] }],
      // Looking shops up: a name alone often doesn't say what a local business is.
      tools: [{ googleSearch: {} }],
      generationConfig: { responseFormat: { text: { mimeType: 'APPLICATION_JSON', schema: SCHEMA } }, maxOutputTokens: 16384 },
    }, fetchImpl);
    const text = r.candidates?.[0]?.content?.parts?.filter((p) => !p.thought).map((p) => p.text ?? '').join('');
    const got = parseSorted(text, batch);
    for (const s of batch) {
      const key = s.shop.toLowerCase();
      // A shop it skipped is noted as "other", so it isn't sent again and again; checking again keeps the old guess.
      out[key] = got[key] ?? (again ? b.shopGuesses?.[key] as SpendCategory | undefined : undefined) ?? 'other';
    }
  }
  return out;
}

import type { ISODate } from './dates';
import type { Cents, Txn } from './types';

// ---------------------------------------------------------------------------------------------
// Where money goes, from the transactions in bank and card exports. Each purchase is put in a
// category by the shop's name (worked out here, on this device), so Insights can show what adds up.
// ---------------------------------------------------------------------------------------------

export type SpendCategory =
  | 'groceries' | 'takeaways' | 'eating-out' | 'gambling' | 'games' | 'shopping' | 'transport' | 'bills'
  | 'health' | 'fees' | 'bnpl' | 'giving' | 'government' | 'transfers' | 'other';

export const CATEGORY_LABEL: Record<SpendCategory, string> = {
  groceries: 'Groceries', takeaways: 'Takeaways and fast food', 'eating-out': 'Cafés and eating out', gambling: 'Lotto and gambling',
  games: 'Games, hobbies and fun', shopping: 'Shopping', transport: 'Transport and car', bills: 'Bills and subscriptions',
  health: 'Health and personal care', fees: 'Fees and interest', bnpl: 'Afterpay and buy now pay later', giving: 'Donations',
  government: 'Government and council', transfers: 'Transfers and payments', other: 'Other',
};

/** Shop name patterns, in order (the first that matches wins), with a tidy name for the shop. */
const RULES: [RegExp, SpendCategory, string?][] = [
  [/payment received|thank you|\btfr\b|transfer|internet banking|online banking|automatic payment|\bA\/P\b|direct credit|salary|wages/i, 'transfers'],
  [/interest|\bfee\b|fees|charge/i, 'fees'],
  [/afterpay/i, 'bnpl', 'Afterpay'], [/laybuy/i, 'bnpl', 'Laybuy'], [/\bzip\b/i, 'bnpl', 'Zip'],
  [/mylotto|lotto/i, 'gambling', 'Lotto'], [/casino|skycity|\bTAB\b|betting|pokies/i, 'gambling'],
  [/uber\s*\*?\s*eats|menulog|delivereasy|doordash/i, 'takeaways', 'Food delivery'],
  [/mcdonald/i, 'takeaways', 'McDonald’s'], [/\bkfc\b/i, 'takeaways', 'KFC'], [/pizza hut|pizza hutt/i, 'takeaways', 'Pizza Hut'],
  [/domino/i, 'takeaways', 'Domino’s'], [/burger king/i, 'takeaways', 'Burger King'], [/subway/i, 'takeaways', 'Subway'],
  [/nando/i, 'takeaways', 'Nando’s'], [/hell pizza/i, 'takeaways', 'Hell Pizza'], [/st pierre/i, 'takeaways', 'St Pierre’s'],
  [/sushi|kebab|noodle|fish ?(&|and|n) ?chips|takeaway|\bpies?\b|carl'?s jr|wendy|taco|popeyes|dumpling/i, 'takeaways'],
  [/caf[eé]|coffee|espresso|restaurant|buffet|bistro|eatery|\bbar\b|brew|pub\b|grill|kitchen|diner|bakery|bubble tea/i, 'eating-out'],
  [/countdown|woolworths/i, 'groceries', 'Woolworths'], [/pak ?n ?save/i, 'groceries', 'Pak’nSave'], [/new world/i, 'groceries', 'New World'],
  [/freshchoice/i, 'groceries', 'FreshChoice'], [/four square/i, 'groceries', 'Four Square'], [/supervalue|super value/i, 'groceries', 'SuperValue'],
  [/supermark|mini ?mart|dairy|butcher|\bmeat\b|fruit|veg|grocer/i, 'groceries'],
  [/z energy|\bmobil\b|\bbp\b|gull|caltex|waitomo|\bnpd\b|fuel/i, 'transport', 'Fuel'],
  [/at public transport|at hop|uber\s*\*?\s*trip|\bola\b|taxi|parking|car ?park|inpark|wilson|vtnz|\baa\b|supercheap|repco|tyre|bridgestone|panel ?beat|\blime\b|\bbeam\b/i, 'transport'],
  [/amazon prime|netflix|spotify|disney|neon|youtube|apple\.com|google|icloud|spark|one ?nz|vodafone|2degrees|skinny|mercury|genesis|contact energy|electric|insurance/i, 'bills'],
  [/chemist|pharm|doctor|medical|dental|dentist|hair|barber|physio|optometr|gym|fitness|beauty|nail/i, 'health'],
  [/playstation|\bpsn\b|steam|xbox|nintendo|hobby|hobbies|games?\b|escape room|cinema|playground|amusement|bowling/i, 'games'],
  [/red cross|st vincent|spca|salvation|charity|donat|hospice|unicef/i, 'giving'],
  [/internal affai|land information|council|\bird\b|nzta|waka kotahi|police|court/i, 'government'],
  [/kmart|warehouse|farmers|briscoes|spotlight|cotton on|postie|shein|aliexpress|temu|amazon|trade ?me|mitre 10|bunnings|noel leeming|harvey norman|jb hi|pascoes|michael hill|liquor|jewel|paypal|ebay/i, 'shopping'],
];

/** The description without card deal notes ("5 Months No Payments No Interest") and extra spaces. */
export function cleanDescription(d: string): string {
  return d.replace(/\s+\d+\s*(months?|mths?)\b.*$/i, '').replace(/\s{2,}/g, ' ').trim();
}

/** A shop's name to group its purchases: the tidy name if known, else its first words without store numbers. */
function shopName(d: string): string {
  const words = cleanDescription(d).replace(/[*#]/g, ' ').split(/\s+/).filter((w) => w && !/\d/.test(w));
  const name = words.slice(0, 2).join(' ') || d;
  return name.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Categories you've chosen for shops (Insights → tap a category → change a shop's), by shop name in lower case. */
export type ShopCategories = Record<string, SpendCategory>;

export function categorize(description: string, mine?: ShopCategories): { category: SpendCategory; shop: string } {
  const d = cleanDescription(description); // so a deal's "No Interest" isn't taken for interest charged
  let found: { category: SpendCategory; shop: string } = { category: 'other', shop: shopName(d) };
  for (const [re, category, shop] of RULES) if (re.test(d)) { found = { category, shop: shop ?? shopName(d) }; break; }
  const chosen = mine?.[found.shop.toLowerCase()];
  return chosen ? { ...found, category: chosen } : found;
}

export interface CategoryTotal { category: SpendCategory; total: Cents; count: number; shops: { shop: string; total: Cents; count: number }[] }
export interface SpendSummary {
  total: Cents;
  count: number;
  categories: CategoryTotal[];
  /** Purchases under $20: small, but they add up. */
  small: { count: number; total: Cents };
}

/** Spending between `from` and `to` (inclusive): purchases only, not payments, refunds or transfers. */
export function summarize(txns: Txn[], from: ISODate, to: ISODate, mine?: ShopCategories): SpendSummary {
  const map = new Map<SpendCategory, CategoryTotal>();
  let total = 0, count = 0;
  const small = { count: 0, total: 0 };
  for (const t of txns) {
    if (t.amount >= 0 || t.date < from || t.date > to) continue;
    const { category, shop } = categorize(t.description, mine);
    if (category === 'transfers') continue;
    const spent = -t.amount;
    total += spent; count++;
    if (spent < 2000) { small.count++; small.total += spent; }
    const c = map.get(category) ?? { category, total: 0, count: 0, shops: [] };
    c.total += spent; c.count++;
    const s = c.shops.find((x) => x.shop === shop);
    if (s) { s.total += spent; s.count++; } else c.shops.push({ shop, total: spent, count: 1 });
    map.set(category, c);
  }
  const categories = [...map.values()].sort((a, b) => b.total - a.total);
  for (const c of categories) c.shops.sort((a, b) => b.total - a.total);
  return { total, count, categories, small };
}

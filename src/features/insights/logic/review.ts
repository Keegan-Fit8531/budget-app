import { addDays, diffDays, type ISODate } from '../../../core/dates';
import { periodContaining, shiftPeriod, type Period } from '../../../engine/periods';
import { planFor } from '../../../engine/plan';
import { owed } from '../../debts/logic/amounts';
import { CATEGORY_LABEL, categorizeTxn, cleanDescription, shopMap, summarize } from './spending';
import type { Budget, Cents, Txn } from '../../../core/types';

// ---------------------------------------------------------------------------------------------
// This month's insights: on payday, the pay cycle that just ended (every transaction from the bank
// connection and uploads, the payslip, the plan) is sent to Gemini with your key, and what comes back
// (what went well, what didn't, tips) is kept in the budget. The totals are worked out here, so
// they're exact; Gemini only writes the words.
// ---------------------------------------------------------------------------------------------

export interface MonthlyReview {
  /** The pay cycle: payday to the day before the next. */
  from: ISODate;
  to: ISODate;
  /** When it was made (ISO date and time). */
  made: string;
  /** Pay that cycle (net), if known. */
  pay?: Cents;
  spent: Cents;
  /** Money in other than pay isn't counted; transfers and card repayments are left out of spending. */
  count: number;
  /** Biggest categories, largest first. */
  categories: { label: string; total: Cents; count: number }[];
  /** The cards and accounts the transactions came from. */
  sources: string[];
  /** Made part way through the cycle (from the button), up to `to`; the full one replaces it on payday. */
  partial?: boolean;
  headline: string;
  summary: string;
  good: string[];
  bad: string[];
  tips: string[];
}

/** Reviews kept: about two years of pay cycles. */
export const KEEP_REVIEWS = 24;

/** The pay cycle that ended most recently before `today` (today's payday starts the next one). */
export function lastCycle(b: Pick<Budget, 'settings'>, today: ISODate): Period {
  return shiftPeriod(periodContaining(today, b.settings), -1, b.settings);
}

interface Source { name: string; card: boolean; txns: Txn[] }

function sources(b: Budget): Source[] {
  return [
    ...(b.debts ?? []).filter((d) => d.transactions?.length).map((d) => ({ name: d.name, card: true, txns: d.transactions! })),
    ...b.accounts.filter((a) => b.accountTransactions?.[a.id]?.length).map((a) => ({ name: a.name, card: false, txns: b.accountTransactions![a.id] })),
  ];
}

/** Transactions in a cycle, across every card and account. */
export function cycleTransactions(b: Budget, c: Pick<Period, 'start' | 'end'>): { source: string; t: Txn }[] {
  return sources(b).flatMap((s) => s.txns.filter((t) => t.date >= c.start && t.date <= c.end).map((t) => ({ source: s.name, t })));
}

/** The cycle so far: from this cycle's payday to today. */
export function cycleSoFar(b: Pick<Budget, 'settings'>, today: ISODate): Period & { partial: true } {
  const p = periodContaining(today, b.settings);
  return { ...p, end: today, days: diffDays(p.start, today) + 1, partial: true };
}

/** Due when the last cycle has transactions and no review yet. */
export function reviewDue(b: Budget, today: ISODate): Period | null {
  const c = lastCycle(b, today);
  if (b.reviews?.[c.start] && !b.reviews[c.start].partial) return null;
  if (b.settings.budgetStart && c.end < b.settings.budgetStart) return null;
  return cycleTransactions(b, c).length ? c : null;
}

/** The numbers worked out here: what was spent and on what, against the cycle before. */
export function cycleNumbers(b: Budget, c: Period) {
  const mine = shopMap(b);
  const all = sources(b).flatMap((s) => s.txns);
  const now = summarize(all, c.start, c.end, mine);
  const prev = shiftPeriod(c, -1, b.settings);
  const before = summarize(all, prev.start, prev.end, mine);
  return { now, before, prev };
}

/** Everything about the cycle, as text for Gemini: your accounts' and goals' names and what was spent, but no account numbers. */
export function reviewInput(b: Budget, c: Period & { partial?: boolean }): string {
  const mine = shopMap(b);
  const { now, before, prev } = cycleNumbers(b, c);
  const plan = planFor(b, c);
  const slip = b.payslips?.[c.start];
  const d = (x: Cents) => (x / 100).toFixed(2);
  const lines: string[] = [];
  lines.push(c.partial
    ? `Pay cycle so far: ${c.start} to today ${c.end} (${c.days} of ${diffDays(c.start, c.nextPayday)} days; next payday ${c.nextPayday}). The cycle isn't over: judge the pace, and say what to watch for the rest of it. Monthly pay, New Zealand.`
    : `Pay cycle: ${c.start} to ${c.end} (${c.days} days). Monthly pay, New Zealand.`);
  lines.push(`Pay (net) this cycle: ${b.payActuals[c.start] !== undefined ? `$${d(b.payActuals[c.start])}` : `about $${d(plan.pay)} (estimate)`}.`);
  if (slip) lines.push(`Payslip: net $${d(slip.net)}${slip.taxableGross ? `, gross $${d(slip.taxableGross)}` : ''}${slip.paye ? `, PAYE $${d(slip.paye)}` : ''}${slip.studentLoan ? `, student loan $${d(slip.studentLoan)}` : ''}${slip.kiwisaver ? `, KiwiSaver $${d(slip.kiwisaver)}` : ''}${slip.employerKiwisaver ? `, employer KiwiSaver $${d(slip.employerKiwisaver)}` : ''}.`);
  lines.push('', 'Planned payday split (what pay was sent to each account for bills, savings and debt):');
  for (const a of plan.accounts) if (a.funded > 0) lines.push(`- ${a.account.name}: $${d(a.funded)}`);
  lines.push(`- Left in the pay account for day-to-day spending: $${d(Math.max(0, plan.leftover))}`);
  lines.push(`Budget rule: ${b.settings.rule.name} (needs ${b.settings.rule.needs}%, wants ${b.settings.rule.wants}%, savings and debt ${b.settings.rule.savings}%).`);
  const debts = (b.debts ?? []).map((x) => ({ name: x.name, owed: owed(x) })).filter((x) => x.owed > 0);
  if (debts.length) lines.push('', 'Debts owed now:', ...debts.map((x) => `- ${x.name}: $${d(x.owed)}`));
  const goals = b.savings ?? [];
  if (goals.length) lines.push('', 'Savings goals:', ...goals.map((g) => `- ${g.name}: $${d(g.balance)} saved${g.target ? ` of $${d(g.target)}` : ''}${g.targetDate ? ` by ${g.targetDate}` : ''}`));
  lines.push('', `Spending this cycle (purchases only, transfers and card repayments left out): $${d(now.total)} over ${now.count} purchases; ${now.small.count} under $20 adding to $${d(now.small.total)}.`);
  for (const k of now.categories) lines.push(`- ${CATEGORY_LABEL[k.category]}: $${d(k.total)} (${k.count}); top: ${k.shops.slice(0, 4).map((s) => `${s.shop} $${d(s.total)} ×${s.count}`).join(', ')}`);
  if (before.count) {
    lines.push('', `The whole cycle before (${prev.start} to ${prev.end}): $${d(before.total)} over ${before.count} purchases.`);
    for (const k of before.categories) lines.push(`- ${CATEGORY_LABEL[k.category]}: $${d(k.total)}`);
  }
  // The purchases themselves, to name shops and habits: not transfers, card repayments or money in
  // (the totals above already cover those), the same shop on the same day once, and at most 300 of
  // the biggest, so a busy month stays small to send.
  const seen = new Map<string, { date: string; source: string; shop: string; amount: Cents; cat: string; n: number }>();
  for (const { source, t } of cycleTransactions(b, c)) {
    if (t.amount >= 0) continue;
    const k = categorizeTxn(t, mine);
    if (k.category === 'transfers') continue;
    const shop = cleanDescription(t.merchant || t.description).replace(/\|/g, ' ').slice(0, 40);
    const key = `${t.date}|${shop}`;
    const was = seen.get(key);
    if (was) { was.amount += -t.amount; was.n++; } else seen.set(key, { date: t.date, source, shop, amount: -t.amount, cat: CATEGORY_LABEL[k.category], n: 1 });
  }
  const rows = [...seen.values()].sort((x, y) => y.amount - x.amount).slice(0, 300).sort((x, y) => (x.date < y.date ? -1 : 1));
  lines.push('', 'Purchases this cycle (date|shop|amount out|category; ×n = that many that day):');
  for (const r of rows) lines.push(`${r.date.slice(5)}|${r.shop}|${d(r.amount)}${r.n > 1 ? ` ×${r.n}` : ''}|${r.cat}`);
  return lines.join('\n');
}

export const REVIEW_INSTRUCTIONS = `You are a friendly, practical money coach for someone in New Zealand on a monthly pay.
You get one pay cycle of their real spending, worked out by their budgeting app, with every transaction.
Write short, specific insights in plain New Zealand English: name the shops, amounts and how often, and compare with the cycle before when it helps.
- headline: one sentence on how the cycle went.
- summary: two or three sentences: pay, what was spent day to day, and what stood out.
- good: two to four things that went well (spending down, bills covered, no gambling, savings growing...).
- bad: two to four things that cost them (takeaways, lots of small purchases, fees or interest, Afterpay, impulse shopping...). Be honest but kind.
- tips: three to five concrete things to try next cycle, each with what it would save (e.g. "Cook on two of the four takeaway nights: about $60 a month").
Use the totals given; don't add them up again. Don't repeat the same point in two lists. No markdown, no emoji.`;

export const REVIEW_SCHEMA = {
  type: 'OBJECT',
  properties: {
    headline: { type: 'STRING' },
    summary: { type: 'STRING' },
    good: { type: 'ARRAY', items: { type: 'STRING' } },
    bad: { type: 'ARRAY', items: { type: 'STRING' } },
    tips: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['headline', 'summary', 'good', 'bad', 'tips'],
};

/** The reply's words, checked, or null if it isn't usable. */
export function parseReview(text: string | undefined): Pick<MonthlyReview, 'headline' | 'summary' | 'good' | 'bad' | 'tips'> | null {
  try {
    const r = JSON.parse(text ?? '') as Record<string, unknown>;
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()).slice(0, 6) : []);
    if (typeof r.headline !== 'string' || !r.headline.trim()) return null;
    return { headline: r.headline.trim(), summary: typeof r.summary === 'string' ? r.summary.trim() : '', good: list(r.good), bad: list(r.bad), tips: list(r.tips) };
  } catch { return null; }
}

/** The review for a cycle, from Gemini's words and the numbers worked out here. */
export function makeReview(b: Budget, c: Period & { partial?: boolean }, words: Pick<MonthlyReview, 'headline' | 'summary' | 'good' | 'bad' | 'tips'>, made: string): MonthlyReview {
  const { now } = cycleNumbers(b, c);
  const used = new Set(cycleTransactions(b, c).map((x) => x.source));
  return {
    from: c.start, to: c.end, made,
    ...(b.payActuals[c.start] !== undefined ? { pay: b.payActuals[c.start] } : {}),
    spent: now.total, count: now.count,
    categories: now.categories.slice(0, 8).map((k) => ({ label: CATEGORY_LABEL[k.category], total: k.total, count: k.count })),
    sources: [...used],
    ...(c.partial ? { partial: true } : {}),
    ...words,
  };
}

/** Keep a review (and only the latest KEEP_REVIEWS). */
export function saveReview(b: Budget, r: MonthlyReview): void {
  const all = { ...(b.reviews ?? {}), [r.from]: r };
  b.reviews = Object.fromEntries(Object.entries(all).sort(([x], [y]) => (x < y ? 1 : -1)).slice(0, KEEP_REVIEWS));
}

/** The day after a cycle ends: the first day its review can be made. */
export const reviewFrom = (c: Pick<Period, 'end'>): ISODate => addDays(c.end, 1);

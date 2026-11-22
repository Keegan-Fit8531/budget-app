// Look at the real budget the way the app does, in the terminal. Read-only: it never writes the file.
//   npm run inspect                                every bank account in one line each
//   npm run inspect -- food                        one account (id or part of its name) in detail
//   npm run inspect -- food --today 2026-11-22     as if it were that day
//   npm run inspect -- food --file other.json      another copy (default ../budget-data/budget.json)
// The output is the owner's own money: read it, don't paste it into commits, PRs or code.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Budget } from '../src/core/types';
import { bringUpToDate } from '../src/state/upgrade';
import { inspectAccount, inspectAll } from '../src/testing/inspect';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const file = resolve(opt('--file') ?? '../budget-data/budget.json');
const today = opt('--today');
if (today) {
  // The app asks `new Date()` for today (todayISO); pin it to midday that day.
  const fixed = new Date(`${today}T12:00:00`).getTime();
  const Real = Date;
  globalThis.Date = class extends Real {
    constructor(...a: ConstructorParameters<typeof Date>) { if (a.length) super(...a); else super(fixed); }
    static now() { return fixed; }
  } as DateConstructor;
}

let raw: string;
try {
  raw = readFileSync(file, 'utf8');
} catch {
  console.error(`Can't read ${file}. Clone the budget-data repo next to budget-app, or pass --file <path>.`);
  process.exit(1);
}
// The same steps the app takes when it loads a budget: older saves tidied, due payments settled, pays balanced.
const b = bringUpToDate(JSON.parse(raw) as Budget);
const which = args.find((x) => !x.startsWith('--'));
console.log((which ? inspectAccount(b, which) : inspectAll(b)).join('\n'));

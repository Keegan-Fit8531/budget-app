import type { Budget } from './types';

/**
 * True when `x` has the shape of a saved budget: enough of it that the app can open it. A backup file or
 * the copy in the repo is checked with this before it replaces what's here, so a cut-off or hand-edited
 * file is turned away with a message instead of leaving a blank screen.
 */
export function looksLikeBudget(x: unknown): x is Budget {
  if (!x || typeof x !== 'object') return false;
  const b = x as Partial<Budget>;
  const s = b.settings as Partial<Budget['settings']> | undefined;
  const list = (v: unknown) => Array.isArray(v) && v.every((e) => !!e && typeof e === 'object');
  return b.version === 1
    && !!s && typeof s === 'object'
    && Number.isInteger(s.paydayDay) && s.paydayDay! >= 1 && s.paydayDay! <= 31
    && typeof s.payAccountId === 'string' && !!s.rule && typeof s.rule === 'object'
    && [b.groups, b.accounts, b.items, b.split].every(list)
    && !!b.payActuals && typeof b.payActuals === 'object' && !Array.isArray(b.payActuals)
    && [b.debts, b.savings].every((v) => v === undefined || list(v))
    && (b.debts ?? []).every((d) => Array.isArray(d.plans));
}

import type { Account, Budget, Cents, Txn } from '../core/types';

// Transfers between your own accounts, read from the account number the bank puts in the description:
// "To: 06-0115-0324910-55 Debit Transfer 083615", "From: 06-0115-0324910-00 Credit Transfer 071301", or an
// older export's "06-0115-0324910-00 DEBIT TRANSFER". The one place that reads them.

/** An account number as numbers (bank, branch, account, suffix), so 06-0115-0324910-055 and -55 are the same. */
export const numberKey = (n: string): string | undefined => {
  const m = n.match(/(\d{2})\D?(\d{4})\D?(\d{7})\D?(\d{2,3})/);
  return m ? m.slice(1).map((x) => String(Number(x))).join('-') : undefined;
};

const TRANSFER_RE = /(?:\b(to|from)\b:?\s*)?(\d{2}-?\d{4}-?\d{7}-?\d{2,3})/i;

/**
 * The account at the other end of a transfer between your own accounts, and which way it went ('to' it or
 * 'from' it: from the description's "To:" / "From:", else from the amount's sign). Undefined when the
 * description has no account number, or the number isn't one of your accounts.
 */
export function ownTransfer(b: Pick<Budget, 'accounts'>, t: Pick<Txn, 'description'> & { amount?: Cents }): { account: Account; dir?: 'to' | 'from' } | undefined {
  const m = t.description.match(TRANSFER_RE);
  const key = m ? numberKey(m[2]) : undefined;
  const account = key ? b.accounts.find((a) => a.number && numberKey(a.number) === key) : undefined;
  if (!account) return undefined;
  const said = m![1]?.toLowerCase() as 'to' | 'from' | undefined;
  return { account, dir: said ?? (t.amount === undefined || t.amount === 0 ? undefined : t.amount < 0 ? 'to' : 'from') };
}

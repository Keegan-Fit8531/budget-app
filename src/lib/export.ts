import type { Row, Sheet } from 'write-excel-file/browser';
import { fmtDay, monthName, toDate, todayISO, type ISODate } from './dates';
import { budgetPeriod, periodContaining, planFor, shiftPeriod, upcomingPayPeriod, type Period } from './engine';
import type { Budget, Cents, RuleBucket } from './types';

// ---------- Which months can be exported ----------

/** How many pays ahead of the next one you can export. */
const AHEAD = 11;

/**
 * The pays you can export, oldest first: from the earliest pay on record (or the pay you're in, when
 * nothing earlier was recorded) through the next 12 to come.
 */
export function exportablePeriods(b: Budget, today: ISODate = todayISO()): Period[] {
  const s = b.settings;
  const current = budgetPeriod(b, today);
  const recorded = Object.keys(b.payActuals).sort()[0];
  let p = recorded && recorded < current.start ? periodContaining(recorded, s) : current;
  const last = shiftPeriod(upcomingPayPeriod(b, today), AHEAD, s);
  const out: Period[] = [];
  while (p.start <= last.start) { out.push(p); p = shiftPeriod(p, 1, s); }
  return out;
}

/** "November 2026 pay" */
export function periodLabel(p: Period): string {
  return `${monthName(p.start)} ${p.start.slice(0, 4)} pay`;
}

export function exportFileName(p: Period): string {
  return `budget-${p.start.slice(0, 7)}-${monthName(p.start).toLowerCase()}-pay.xlsx`;
}

// ---------- The spreadsheet ----------

const MONEY = '"$"#,##0.00;[Red]-"$"#,##0.00';
const DATE = 'ddd d mmm yyyy';
const HEAD = { fontWeight: 'bold', backgroundColor: '#E8ECF4', bottomBorderStyle: 'thin' } as const;
const BUCKETS: Record<RuleBucket, string> = { needs: 'Needs', wants: 'Wants', savings: 'Savings and debt' };

const text = (value: string, bold = false) => (bold ? { value, fontWeight: 'bold' as const } : { value });
const cash = (c: Cents, bold = false) => ({
  value: c / 100, type: Number, format: MONEY, align: 'right' as const, ...(bold ? { fontWeight: 'bold' as const } : {}),
});
const day = (iso: ISODate) => ({ value: toDate(iso), type: Date, format: DATE, align: 'left' as const });
const head = (labels: string[], moneyFrom: number): Row =>
  labels.map((value, i) => ({ value, ...HEAD, ...(i >= moneyFrom ? { align: 'right' as const } : {}) }));

/**
 * One pay as a workbook: a summary, what payday sends to each account, and every payment due in it.
 * Amounts are real numbers (not text), so they can be summed and charted in Excel, Numbers or Sheets.
 */
export function monthSheets(b: Budget, period: Period, today: ISODate = todayISO()): Sheet<Blob>[] {
  const plan = planFor(b, period, today);
  const payId = b.settings.payAccountId;
  const groupOf = (groupId: string) => b.groups.find((g) => g.id === groupId);
  const slip = b.payslips?.[period.start];
  const paySource = plan.payIsActual ? (slip ? 'From your payslip' : 'Typed in')
    : plan.payEstimateFrom ? `Estimate: ${monthName(plan.payEstimateFrom)}'s pay` : 'Estimate: your expected pay';

  // --- Summary ---
  const summary: Row[] = [
    [{ value: periodLabel(period), fontWeight: 'bold', fontSize: 16 }],
    [text(`${fmtDay(period.start)} – ${fmtDay(period.end)} · ${period.days} days`)],
    [],
    [text('Payday'), day(period.start)],
    [text('Next payday'), day(period.nextPayday)],
    [],
    [text('Pay'), cash(plan.pay), text(paySource)],
    [text('Total sent to accounts'), cash(plan.totalSplit)],
    [text('Left in pay account', true), cash(plan.leftover, true)],
    [text('Payments due this pay'), cash(plan.dues.reduce((t, d) => t + d.item.amount, 0))],
  ];
  if (slip) {
    const lines: [string, Cents | undefined][] = [
      ['Taxable gross', slip.taxableGross], ['PAYE', slip.paye], ['Student loan', slip.studentLoan],
      ['KiwiSaver', slip.kiwisaver], ['Employer KiwiSaver', slip.employerKiwisaver], ['Net pay', slip.net],
    ];
    summary.push([], head(['Payslip', 'Amount'], 1), [text('Paid on'), day(slip.payDay)]);
    for (const [label, c] of lines) if (c !== undefined) summary.push([text(label), cash(c)]);
  }
  // Where the pay goes, by group. What stays in the pay account counts for that account's group.
  const sentTo = (id: string) => plan.accounts.find((a) => a.account.id === id)?.funded ?? 0;
  const byGroup = b.groups.map((g) => ({
    g, sent: b.accounts.filter((a) => !a.archived && a.groupId === g.id).reduce((t, a) => t + sentTo(a.id), 0),
  })).filter((x) => x.sent !== 0);
  if (byGroup.length) {
    summary.push([], head(['Group', 'Amount', 'Counts as', 'Share of pay'], 1));
    for (const { g, sent } of byGroup) {
      summary.push([text(g.name), cash(sent), text(BUCKETS[g.bucket]),
        plan.pay > 0 ? { value: sent / plan.pay, type: Number, format: '0.0%', align: 'right' } : null]);
    }
  }

  // --- Accounts ---
  const rows = plan.accounts.filter((a) => a.account.id === payId || a.funded !== 0 || a.need !== 0);
  const accounts: Row[] = [head(['Account', 'Group', 'Type', 'Sent on payday', 'Costs this pay', 'Left at end of pay'], 3)];
  for (const a of rows) {
    const isPay = a.account.id === payId;
    accounts.push([
      text(a.account.name), text(groupOf(a.account.groupId)?.name ?? ''),
      text(isPay ? 'Pay account (keeps the rest)' : a.account.kind === 'bank' ? 'Bank account' : 'Paid out'),
      cash(a.funded), cash(a.need), a.diff === null ? null : cash(a.diff),
    ]);
  }
  accounts.push([text('Total', true), null, null,
    cash(rows.reduce((t, a) => t + a.funded, 0), true), cash(rows.reduce((t, a) => t + a.need, 0), true), null]);

  // --- Payments ---
  const payments: Row[] = [head(['Date', 'Payment', 'Account', 'Group', 'Amount'], 4)];
  const accountOf = new Map(b.accounts.map((a) => [a.id, a]));
  for (const d of plan.dues) {
    const acc = accountOf.get(d.item.accountId);
    payments.push([day(d.date), text(d.item.name), text(acc?.name ?? ''), text(acc ? groupOf(acc.groupId)?.name ?? '' : ''), cash(d.item.amount)]);
  }
  payments.push([text('Total', true), null, null, null, cash(plan.dues.reduce((t, d) => t + d.item.amount, 0), true)]);

  return [
    { sheet: 'Summary', data: summary, columns: [{ width: 28 }, { width: 18 }, { width: 30 }, { width: 14 }] },
    { sheet: 'Accounts', data: accounts, stickyRowsCount: 1, columns: [{ width: 28 }, { width: 18 }, { width: 28 }, { width: 18 }, { width: 18 }, { width: 20 }] },
    { sheet: 'Payments', data: payments, stickyRowsCount: 1, columns: [{ width: 18 }, { width: 32 }, { width: 26 }, { width: 18 }, { width: 16 }] },
  ];
}

/** Build the spreadsheet for a pay and download it. The spreadsheet writer is only loaded when used. */
export async function downloadMonth(b: Budget, period: Period): Promise<void> {
  const { default: writeXlsxFile } = await import('write-excel-file/browser');
  await writeXlsxFile(monthSheets(b, period)).toFile(exportFileName(period));
}

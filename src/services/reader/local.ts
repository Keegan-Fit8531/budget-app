import { matchDebt, readDocument, type ReadDocument } from './documents';
import type { Debt } from '../../core/types';
import type { Extraction, Fig } from './types';

// ---------------------------------------------------------------------------------------------
// The backup reader: the one that runs on this device (PDF text, or text recognised in a photo),
// filling in the same form as Gemini so it goes through the same checks and rundown. It only knows
// one payslip layout and common statement wordings, and can't read Afterpay screens.
// ---------------------------------------------------------------------------------------------

const fig = (c: number | undefined, label: string): Fig | undefined => (c === undefined ? undefined : { amount: (c / 100).toFixed(2), label });

/** Convert what the on-device reader found into the reader form. */
export function toExtraction(d: ReadDocument, debts: Debt[]): Extraction {
  if (d.kind === 'payslip') {
    const s = d.payslip;
    return {
      kind: 'payslip',
      payslip: {
        payDay: s.payDay, net: fig(s.net, 'Total Payments'), taxableGross: fig(s.taxableGross, 'Taxable gross'), paye: fig(s.paye, 'PAYE'),
        studentLoan: fig(s.studentLoan, 'Student loan'), kiwisaver: fig(s.kiwisaver, 'KiwiSaver'), employerKiwisaver: fig(s.employerKiwisaver, 'Employer KiwiSaver'),
      },
    };
  }
  const s = d.statement;
  const match = matchDebt(debts, d.text);
  return {
    kind: 'statement',
    statement: { debtId: match?.id ?? null, balance: fig(s.balance, 'Balance'), statementDate: s.date, limit: fig(s.limit, 'Credit limit'), minimum: fig(s.minimum, 'Minimum payment'), avoidInterest: fig(s.avoidInterest, 'To avoid interest') },
  };
}

export async function readOnDevice(file: File, debts: Debt[], onProgress?: (fraction: number) => void): Promise<Extraction> {
  return toExtraction(await readDocument(file, onProgress), debts);
}

import type { ISODate } from './dates';
import type { Cents } from './types';

export interface Payslip {
  payDay: ISODate;
  net: Cents;
  taxableGross?: Cents;
  paye?: Cents;
  studentLoan?: Cents;
  kiwisaver?: Cents;
  employerKiwisaver?: Cents;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const AMT = '\\$\\s*([\\d,]+\\.\\d{2})';

function amount(text: string, label: string): Cents | undefined {
  const m = text.match(new RegExp(`${label}\\s*:?\\s*-?\\s*${AMT}`, 'i'));
  return m ? Math.round(parseFloat(m[1].replace(/,/g, '')) * 100) : undefined;
}

/** Pull the numbers we need out of a payslip's text. Returns null if it doesn't look like a payslip. */
export function parsePayslipText(raw: string): Payslip | null {
  const text = raw.replace(/\s+/g, ' ');
  const d = text.match(/Pay Day\s*:\s*(\d{1,2})\s*-\s*([A-Za-z]{3})\s*-\s*(\d{4})/i);
  const net = amount(text, 'Total Payments') ?? amount(text, 'NET PAY AMOUNT');
  if (!d || net === undefined) return null;
  const month = MONTHS[d[2].toLowerCase()];
  if (!month) return null;
  return {
    payDay: `${d[3]}-${String(month).padStart(2, '0')}-${d[1].padStart(2, '0')}`,
    net,
    taxableGross: amount(text, 'TAXABLE GROSS'),
    paye: amount(text, 'P\\s*\\.\\s*A\\s*\\.\\s*Y\\s*\\.\\s*E\\s*\\.\\s*Tax'),
    studentLoan: amount(text, 'Stud(?:ent)? Loan'),
    kiwisaver: amount(text, 'Kiwi\\s*[\\d.]+\\s*%'),
    employerKiwisaver: amount(text, 'KSave\\s*[\\d.]+\\s*%'),
  };
}

/** The text of a PDF file, read in the browser (nothing is uploaded anywhere). */
export async function readPdfText(file: File): Promise<string> {
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  let text = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((it) => ('str' in it ? it.str : '')).join(' ') + '\n';
  }
  return text;
}

/** Read a PDF payslip in the browser and parse it. */
export async function readPayslipPdf(file: File): Promise<Payslip | null> {
  return parsePayslipText(await readPdfText(file));
}

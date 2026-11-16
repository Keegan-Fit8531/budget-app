// ---------------------------------------------------------------------------------------------
// A PDF's text, page by page, read on this device with its columns kept by spacing (so "Withdrawals"
// and "Deposits" still line up under their headings). A long statement is sent to Gemini as this text,
// a few pages at a time, instead of as one huge PDF it couldn't answer in one go.
// ---------------------------------------------------------------------------------------------

interface Item { s: string; x: number; y: number }

/** One page's text as lines, each word placed at about its position across the page. */
export function layoutPage(items: Item[]): string {
  const rows: { y: number; items: Item[] }[] = [];
  for (const it of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const row = rows.find((r) => Math.abs(r.y - it.y) < 2.5);
    if (row) row.items.push(it); else rows.push({ y: it.y, items: [it] });
  }
  return rows
    .sort((a, b) => b.y - a.y)
    .map((r) => {
      let line = '';
      for (const it of r.items.sort((a, b) => a.x - b.x)) {
        const col = Math.round(it.x / 4); // about 4 points a character
        if (line.length < col) line = line.padEnd(col);
        else if (line && !line.endsWith(' ')) line += ' ';
        line += it.s;
      }
      return line.trimEnd();
    })
    .filter(Boolean)
    .join('\n');
}

/** Each page's text, or an empty list if the PDF can't be opened. */
export async function readPdfPages(file: File): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages: string[] = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const { items } = await page.getTextContent();
      pages.push(layoutPage(items.flatMap((it) => ('str' in it && it.str.trim() ? [{ s: it.str, x: it.transform[4], y: it.transform[5] }] : []))));
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  return pages;
}

/** Whether the pages have real text (a scanned PDF is only pictures, and has to be sent as it is). */
export const hasText = (pages: string[]) => pages.length > 0 && pages.join('').replace(/\s/g, '').length >= 150 * pages.length;

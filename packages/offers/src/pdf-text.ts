import { getDocumentProxy } from "unpdf";

/**
 * The text of a PDF, for reading an invoice's number, amount and dates.
 * Returns null when the file is not a PDF or holds no text (a scan, a photo):
 * such a document is reported as unreadable, never guessed at.
 * Only the first pages are read; the text is used at once and not stored.
 */
export async function extractPdfText(bytes: Uint8Array, options: { maxPages?: number; maxChars?: number } = {}): Promise<string | null> {
  const maxPages = options.maxPages ?? 5;
  const maxChars = options.maxChars ?? 20_000;
  if (Buffer.from(bytes.subarray(0, 5)).toString("latin1") !== "%PDF-") return null;
  try {
    // unpdf takes ownership of the buffer it is given, so it gets its own copy.
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const pages: string[] = [];
    for (let number = 1; number <= Math.min(pdf.numPages, maxPages); number++) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items as { str?: string; hasEOL?: boolean }[]) {
        text += (item.str ?? "") + (item.hasEOL ? "\n" : "");
      }
      pages.push(text);
    }
    const text = pages
      .join("\n")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    // A handful of characters is a stamp or a page number on a scan, not an invoice.
    return text.length >= 40 ? text.slice(0, maxChars) : null;
  } catch {
    return null;
  }
}

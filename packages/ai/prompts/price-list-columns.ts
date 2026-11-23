import { emailData, SHARED_RULES } from "./shared-rules";

/**
 * Job: say which column of a customer's price list holds what.
 * Used by: price list upload, only when the column titles alone do not say it.
 * The model sees the titles and a few sample rows and answers with column
 * numbers. It never copies a price: the values are read by code afterwards, and
 * the customer confirms a preview before the list is used.
 */
export interface PriceListColumnsInput {
  headers: string[];
  /** The first few data rows, as text. */
  sampleRows: string[][];
}

export function priceListColumnsPrompt(input: PriceListColumnsInput): { system: string; user: string } {
  const system = `
You help read a small company's price list from a spreadsheet.

${SHARED_RULES}

Task: the spreadsheet's columns are numbered from 0. Decide which column holds:
- "name": the item's name or description (required),
- "price": the net unit price, without VAT (required). If there is a net and a
  gross price, choose the net one,
- "code": the item code, index or SKU (or null if there is none),
- "unit": the unit of measure such as pc, kg, m, szt. (or null),
- "aliases": other names or keywords for the item (or null).

Use each column at most once. If you cannot tell which column is the name or the
price, answer null for it: do not guess.

Answer with one line of JSON and nothing else:
{"name":<number or null>,"price":<number or null>,"code":<number or null>,"unit":<number or null>,"aliases":<number or null>}
`.trim();

  const line = (cells: string[]) => cells.map((cell, i) => `[${i}] ${cell.slice(0, 80)}`).join(" | ");
  const user = [
    emailData("column titles", line(input.headers)),
    emailData("sample rows", input.sampleRows.map(line).join("\n")),
  ].join("\n\n");
  return { system, user };
}

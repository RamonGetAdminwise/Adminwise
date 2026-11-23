import { emailData, SHARED_RULES } from "./shared-rules";

/**
 * Job: decide what kind of document an attachment is, for the folder name it
 * is filed under. Used by: the filing job, only when the file name alone does
 * not say it. The file itself is not read; the model sees its name and the
 * email it came with.
 */
export interface FileTypeInput {
  fileName: string;
  subject: string;
  /** The email text, or "" when it is no longer available. */
  body: string;
}

export function fileTypePrompt(input: FileTypeInput): { system: string; user: string } {
  const system = `
You sort email attachments for a small company's filing.

${SHARED_RULES}

Task: decide which one kind of document the attachment named below most likely is,
from its file name and the email it arrived with.

Kinds:
- "invoice": an invoice, pro-forma invoice, credit note or receipt.
- "order": a purchase order, order form or order confirmation.
- "contract": a contract, agreement, terms to sign, NDA.
- "offer": an offer, quote, quotation or price proposal.
- "other": anything else, or when you cannot tell.

Judge this one file. The email may have come with several attachments and talk
about the others too ("the invoice and the bank statement"): go by this file's
own name first. A bank statement, a list, a timesheet, a letter from an
authority, a certificate or a picture of a place or product is "other". A photo
or scan of a receipt or an invoice is an "invoice", also when the file name is
only a camera number and the email says what it shows.

If you cannot tell, answer "other". Do not guess from a single weak hint.

Answer with one line of JSON and nothing else:
{"type":"invoice|order|contract|offer|other"}
`.trim();

  const user = [
    emailData("attachment file name", input.fileName),
    emailData("email subject", input.subject),
    emailData("email text", input.body || "(not available)"),
  ].join("\n\n");
  return { system, user };
}

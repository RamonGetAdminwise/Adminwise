import { createHash } from "node:crypto";
import { classifyDocument } from "@adminwise/ai";
import { ConnectionUnavailableError, localClock } from "@adminwise/core";
import { canFile, forCustomer, type DocType, type Message } from "@adminwise/db";
import { GraphAuthError, GraphError, MAX_FILE_BYTES, type AttachmentInfo } from "@adminwise/mail";
import { describeError, type Deps } from "../deps";
import { FREE_MAIL, ownDomains, prefilter } from "./prefilter";

/** Smaller files are signature logos, icons and tracking pixels, not documents. */
export const MIN_FILE_BYTES = 10 * 1024;
/** The folder Microsoft creates for the app in the customer's OneDrive; shown to the customer, not used in calls. */
export const APP_FOLDER = "Apps/Adminwise";

const word = (pattern: string) => new RegExp(`(^|[^a-z0-9])(${pattern})`, "i");
/** File-name hints in the languages our customers work in. First match wins. */
const NAME_RULES: [DocType, RegExp][] = [
  ["invoice", word("faktur|invoice|rechnung|factuur|pro-?forma|credit[-_ ]?note|korekt|receipt|paragon|fv[-_ ]?\\d|fa[-_ ]?\\d")],
  ["order", word("zam[oó]wieni|order|bestellung|bestelling|objedn[aá]vk|po[-_ ]?\\d|zam[-_ ]?\\d")],
  ["contract", word("umow|contract|agreement|vertrag|overeenkomst|smlouv|nda(?![a-z])")],
  ["offer", word("ofert|offer|quot|angebot|nab[ií]dk|wycen")],
];

/** The document type when the file name says it; null when the model should look at the email too. */
export function guessDocType(fileName: string): DocType | null {
  return NAME_RULES.find(([, pattern]) => pattern.test(fileName))?.[0] ?? null;
}

/** Characters OneDrive refuses in names, and names that would escape the folder. */
export function safeName(name: string, fallback: string): string {
  const cleaned = [...name]
    .filter((character) => character.charCodeAt(0) >= 32)
    .join("")
    .replace(/["*:<>?/\\|]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^[\s.]+|[\s.]+$/g, "")
    .slice(0, 120);
  return cleaned || fallback;
}

/** The folder a sender's documents go into: their company domain, or their mailbox name for free mail providers. */
export function senderFolder(message: Pick<Message, "senderDomain" | "fromAddress">): string {
  const domain = message.senderDomain;
  if (domain && !FREE_MAIL.has(domain)) return safeName(domain, "unknown sender");
  return safeName(message.fromAddress?.split("@")[0] ?? domain, "unknown sender");
}

/** "<sender>/<YYYY-MM>/<YYYY-MM-DD>_<type>_<name>", with " (2)", " (3)" before the extension for later attempts. */
export function filingPath(input: { folder: string; localDate: string; docType: DocType; name: string; attempt: number }): string {
  const original = safeName(input.name, "attachment");
  const dot = original.lastIndexOf(".");
  const stem = dot > 0 ? original.slice(0, dot) : original;
  const extension = dot > 0 ? original.slice(dot) : "";
  const counter = input.attempt > 1 ? ` (${input.attempt})` : "";
  return `${input.folder}/${input.localDate.slice(0, 7)}/${input.localDate}_${input.docType}_${stem}${counter}${extension}`;
}

export function isDocument(attachment: AttachmentInfo): boolean {
  return !attachment.isInline && attachment.sizeBytes >= MIN_FILE_BYTES && attachment.name.trim() !== "";
}

export interface FilingResult {
  filed: number;
  duplicates: number;
  queued: number;
  outcome: string;
}

/**
 * The filing job. For one stored inbound message, saves each real attachment
 * to the customer's OneDrive, in the app's own folder:
 *   Apps/Adminwise/<Sender>/<YYYY-MM>/<YYYY-MM-DD>_<type>_<original name>
 *
 * - Inline pictures, signature logos and files under 10 KB are skipped.
 * - A file whose content was filed before (same hash) is not filed again.
 * - A different file with the same name gets a counter; nothing is overwritten.
 * - When OneDrive cannot be reached the attachment is remembered as "queued"
 *   (metadata only) and fetched from the mailbox again later. Nothing is lost.
 * - Only metadata and the content hash are stored here, never the file.
 *
 * Safe to run twice for the same message: attachments already dealt with are skipped.
 */
export async function fileAttachments(deps: Deps, job: { customerId: string; messageId: string }): Promise<FilingResult> {
  const scope = forCustomer(deps.db, job.customerId);
  const runId = await scope.startJobRun("filing", job.messageId);
  const now = deps.now?.() ?? new Date();
  let inputTokens = 0;
  let outputTokens = 0;
  const done = async (outcome: string, status: "succeeded" | "skipped" = "succeeded", counts = { filed: 0, duplicates: 0, queued: 0 }) => {
    await scope.finishJobRun(runId, { status, inputTokens, outputTokens, outcome });
    return { ...counts, outcome };
  };

  try {
    const message = await scope.getMessage(job.messageId);
    if (!message || message.direction !== "inbound" || !message.connectionId) return await done("no_message", "skipped");
    const connection = await scope.getConnection(message.connectionId);
    // Filing needs a connected Microsoft 365 account: forwarding-address customers do not get it.
    if (!connection || connection.provider !== "microsoft") return await done("no_drive");
    if (connection.status !== "active") return await done("mailbox_disconnected", "skipped");
    // Connected before filing existed: everything else keeps working, filing waits for one reconnect.
    if (!canFile(connection)) return await done("filing_off");

    // Mail from colleagues, automatic replies and newsletters is not filed. Notifications are: invoices often arrive that way.
    const [customer, users, connections] = await Promise.all([scope.getCustomer(), scope.listUsers(), scope.listConnections()]);
    const internal = ownDomains([...users.map((u) => u.email), ...connections.map((c) => c.emailAddress)]);
    const kind = (message.fromAddress ? prefilter(message, internal) : null) ?? message.classification;
    if (kind === "internal" || kind === "auto_reply" || kind === "newsletter") return await done(`not_filed:${kind}`);

    let attachments: AttachmentInfo[];
    try {
      attachments = await deps.outlook.listAttachments(scope, connection.id, message.providerMessageId);
    } catch (error) {
      if (error instanceof GraphError && error.status === 404) return await done("message_gone", "skipped");
      throw error;
    }

    const localDate = localClock(message.receivedAt, customer.timeZone).date;
    const counts = { filed: 0, duplicates: 0, queued: 0 };

    for (const attachment of attachments.filter(isDocument)) {
      const existing = await scope.getFiledDocument(message.providerMessageId, attachment.id);
      if (existing && existing.status !== "queued") continue;

      const record = {
        messageId: message.id,
        connectionId: connection.id,
        providerMessageId: message.providerMessageId,
        attachmentId: attachment.id,
        originalName: attachment.name,
        sizeBytes: attachment.sizeBytes,
        senderFolder: existing?.senderFolder || senderFolder(message),
        receivedAt: message.receivedAt,
        at: now,
      };

      // Microsoft tells the size up front: a file that is too large is not downloaded at all.
      if (attachment.sizeBytes > MAX_FILE_BYTES) {
        await scope.saveFiledDocument({ ...record, contentHash: null, docType: null, status: "failed", error: "too_large" });
        continue;
      }
      const content = await deps.outlook.downloadAttachment(scope, connection.id, message.providerMessageId, attachment.id);
      const contentHash = createHash("sha256").update(content).digest("hex");
      if (content.byteLength > MAX_FILE_BYTES) {
        await scope.saveFiledDocument({ ...record, contentHash, docType: null, status: "failed", error: "too_large" });
        continue;
      }

      const earlier = await scope.findFiledByHash(contentHash);
      if (earlier) {
        await scope.saveFiledDocument({ ...record, contentHash, docType: earlier.docType, status: "duplicate", duplicateOf: earlier.id });
        counts.duplicates++;
        continue;
      }

      let docType = existing?.docType ?? guessDocType(attachment.name);
      if (!docType) {
        try {
          const answer = await classifyDocument(deps.ai, {
            fileName: attachment.name,
            subject: message.subject,
            body: message.bodyText ?? "",
          });
          inputTokens += answer.usage.inputTokens;
          outputTokens += answer.usage.outputTokens;
          docType = answer.type;
        } catch {
          // The folder name is not worth losing the document over.
          docType = "other";
        }
      }

      try {
        let stored: { path: string; itemId: string } | null = null;
        for (let attempt = 1; attempt <= 50 && !stored; attempt++) {
          const path = filingPath({ folder: record.senderFolder, localDate, docType, name: attachment.name, attempt });
          try {
            const uploaded = await deps.outlook.uploadFile(scope, connection.id, path, content, attachment.contentType);
            stored = { path, itemId: uploaded.itemId };
          } catch (error) {
            // A different file already has this name: keep both, try the next counter.
            if (!(error instanceof GraphError && error.status === 409)) throw error;
          }
        }
        if (!stored) throw new GraphError("No free file name after 50 attempts", 409);
        try {
          await scope.saveFiledDocument({ ...record, contentHash, docType, status: "filed", storedPath: stored.path, driveItemId: stored.itemId });
          counts.filed++;
        } catch (error) {
          // The same file arrived in two mails at the same moment and the other one was recorded first.
          if ((error as { code?: string }).code !== "23505") throw error;
          const winner = await scope.findFiledByHash(contentHash);
          await scope.saveFiledDocument({ ...record, contentHash, docType, status: "duplicate", duplicateOf: winner?.id ?? null });
          counts.duplicates++;
        }
      } catch (error) {
        if (error instanceof ConnectionUnavailableError || error instanceof GraphAuthError) throw error;
        if (!(error instanceof GraphError)) throw error;
        // OneDrive is not reachable right now. Remember the attachment and stop: the rest would fail the same way.
        await scope.saveFiledDocument({ ...record, contentHash, docType, status: "queued", error: describeError(error) });
        await scope.setDriveError(connection.id, describeError(error));
        counts.queued++;
        break;
      }
    }

    if (counts.queued === 0 && connection.driveError && counts.filed > 0) await scope.setDriveError(connection.id, null);
    return await done(`filed:${counts.filed},duplicate:${counts.duplicates},queued:${counts.queued}`, "succeeded", counts);
  } catch (error) {
    if (error instanceof ConnectionUnavailableError || error instanceof GraphAuthError) {
      await scope.finishJobRun(runId, { status: "skipped", inputTokens, outputTokens, error: describeError(error) });
      return { filed: 0, duplicates: 0, queued: 0, outcome: "mailbox_disconnected" };
    }
    await scope.finishJobRun(runId, { status: "failed", inputTokens, outputTokens, error: describeError(error) });
    throw error;
  }
}

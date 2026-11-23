import type { AiClient } from "@adminwise/ai";
import type { JobQueue, OutlookGateway } from "@adminwise/core";
import type { Db } from "@adminwise/db";
import type { OutboundMailer } from "@adminwise/mail";

export interface PdfRenderer {
  render(html: string): Promise<Uint8Array>;
}

/**
 * Everything a job needs from the outside world. Production wires in the real
 * services (main.ts); tests wire in fakes, so the same job code runs in both.
 */
export interface Deps {
  db: Db;
  queue: JobQueue;
  ai: AiClient;
  mailer: OutboundMailer;
  outlook: OutlookGateway;
  /** Prints an HTML page to PDF (offers, order confirmations). */
  pdf: PdfRenderer;
  appName: string;
  appBaseUrl: string;
  /** Where operator alerts go; unset = no alerts. */
  alertEmail?: string | null;
  now?: () => Date;
}

/** A short technical reason for the job log. Built from our own error messages, never from email content. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 300);
  return "Unknown error";
}

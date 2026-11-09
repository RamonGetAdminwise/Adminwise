import type { AiClient } from "@bo/ai";
import type { JobQueue, OutlookGateway } from "@bo/core";
import type { Db } from "@bo/db";
import type { OutboundMailer } from "@bo/mail";

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
  appName: string;
  appBaseUrl: string;
  now?: () => Date;
}

/** A short technical reason for the job log. Built from our own error messages, never from email content. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 300);
  return "Unknown error";
}

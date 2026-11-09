export type Provider = "microsoft" | "forwarding";
export type ConnectionStatus = "active" | "needs_reconnect" | "revoked" | "disconnected";
export type Classification = "business" | "newsletter" | "notification" | "auto_reply" | "internal";
export type DraftDestination = "outlook_drafts" | "email_to_customer";
export type JobStatus = "running" | "succeeded" | "failed" | "skipped";

export interface Customer {
  id: string;
  name: string;
  slug: string;
  languages: string[];
  timeZone: string;
  signatureText: string;
  voiceProfile: string;
  createdAt: Date;
}

export interface User {
  id: string;
  customerId: string;
  email: string;
}

export interface SessionInfo {
  userId: string;
  customerId: string;
  email: string;
}

export interface MailboxConnection {
  id: string;
  customerId: string;
  provider: Provider;
  emailAddress: string;
  status: ConnectionStatus;
  /** Decrypted by the data layer; null when never connected. */
  accessToken: string | null;
  refreshToken: string | null;
  tokenExpiresAt: Date | null;
  subscriptionId: string | null;
  subscriptionExpiresAt: Date | null;
  clientState: string | null;
  deltaLink: string | null;
  lastSyncAt: Date | null;
  lastError: string | null;
  createdAt: Date;
}

export interface HeaderFlags {
  autoSubmitted?: boolean;
  bulk?: boolean;
  list?: boolean;
}

export interface Message {
  id: string;
  customerId: string;
  threadId: string;
  connectionId: string | null;
  dedupeKey: string;
  providerMessageId: string;
  direction: "inbound" | "outbound";
  senderDomain: string;
  fromAddress: string | null;
  subject: string;
  receivedAt: Date;
  headerFlags: HeaderFlags;
  attachmentNames: string[];
  classification: Classification | null;
  language: string | null;
  bodyText: string | null;
  bodyPurgedAt: Date | null;
}

export interface NewMessage {
  threadKey: string;
  connectionId: string | null;
  dedupeKey: string;
  providerMessageId: string;
  direction: "inbound" | "outbound";
  senderDomain: string;
  fromAddress: string;
  subject: string;
  receivedAt: Date;
  headerFlags: HeaderFlags;
  attachmentNames: string[];
  bodyText: string;
}

export interface Draft {
  id: string;
  customerId: string;
  messageId: string;
  threadId: string;
  destination: DraftDestination;
  status: "pending" | "created" | "failed";
  language: string | null;
  languageListed: boolean;
  providerDraftId: string | null;
  bodyText: string | null;
  createdAt: Date;
}

/** One line of the daily brief: a draft plus the metadata needed to describe it. */
export interface DraftSummary {
  id: string;
  subject: string;
  senderDomain: string;
  language: string | null;
  languageListed: boolean;
  destination: DraftDestination;
}

export interface JobRun {
  id: string;
  customerId: string | null;
  job: string;
  status: JobStatus;
  ref: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  inputTokens: number;
  outputTokens: number;
  error: string | null;
}

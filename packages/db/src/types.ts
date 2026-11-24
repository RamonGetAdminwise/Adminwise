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
  /** Working days of silence before a follow-up is drafted (1 to 30). */
  followUpDays: number;
  /** Which incoming business mail gets a reply draft. */
  replyDrafts: ReplyDraftMode;
  // ---- offers (phase 3) ----
  /** Language of the offer document's own texts. */
  offerLanguage: OfferLanguage;
  offerLayout: OfferLayout;
  /** ISO 4217 code; price list prices are net amounts in this currency. */
  currency: string;
  /** Percent, added in the totals. */
  vatRate: number;
  paymentTerms: string;
  offerValidDays: number;
  /** "OF/{YYYY}/{NNN}": {YYYY} is the year, {NNN} a counter that restarts each year. */
  offerNumberPattern: string;
  /** Address and tax number, printed in the offer header. */
  companyDetails: string;
  bankDetails: string;
  offerFooter: string;
  /** "#rrggbb" */
  brandColor: string;
  // ---- guided setup (phase 4) ----
  /** Null while the "Getting started" guide is still shown after sign-in. */
  setupFinishedAt: Date | null;
  setupTestSentAt: Date | null;
  /** Details read from an uploaded sample document, waiting for the owner's yes or no. */
  offerProposal: OfferProposal | null;
  // ---- billing details, for our own invoices to the customer ----
  billingName: string;
  billingAddress: string;
  /** "" = not given, an EU country's ISO code, or "OTHER". */
  billingCountry: string;
  vatNumber: string;
  vatStatus: "none" | "valid" | "invalid" | "unverified";
  vatCheckedAt: Date | null;
  /** The name the EU register holds for the VAT number, when it gives one. */
  vatRegisteredName: string | null;
  // ---- plan and trial ----
  plan: "start" | "run";
  billingStatus: "trial" | "active" | "read_only" | "internal";
  trialEndsAt: Date;
  readOnlySince: Date | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  /** End of the period that has been paid for. */
  currentPeriodEnd: Date | null;
  /** The owner cancelled: the subscription stops at currentPeriodEnd. */
  cancelAtPeriodEnd: boolean;
  createdAt: Date;
}

/** What could be read from a sample offer or invoice. Every value is printed on that document; null = not found. */
export interface OfferProposal {
  companyDetails: string | null;
  bankDetails: string | null;
  paymentTerms: string | null;
  currency: string | null;
  vatRate: number | null;
  offerLanguage: OfferLanguage | null;
}

/**
 * "all" = every business mail; "sales" = only quote requests, acceptances of an offer and replies
 * about an invoice being chased; "off" = no reply drafts.
 */
export type ReplyDraftMode = "all" | "sales" | "off";
export const REPLY_DRAFT_MODES: ReplyDraftMode[] = ["all", "sales", "off"];

export type OfferLanguage = "en" | "pl";
export type OfferLayout = "classic" | "modern" | "compact";
export const OFFER_LANGUAGES: OfferLanguage[] = ["en", "pl"];
export const OFFER_LAYOUTS: OfferLayout[] = ["classic", "modern", "compact"];

export interface OfferSettings {
  offerLanguage: OfferLanguage;
  offerLayout: OfferLayout;
  currency: string;
  vatRate: number;
  paymentTerms: string;
  offerValidDays: number;
  offerNumberPattern: string;
  companyDetails: string;
  bankDetails: string;
  offerFooter: string;
  brandColor: string;
}

/** Which sheet column holds what, as confirmed by the customer. Indexes are 0-based. */
export interface PriceListMapping {
  code: number | null;
  name: number;
  unit: number | null;
  price: number;
  aliases: number | null;
  source: "headers" | "model" | "customer";
}

export interface PriceListRaw {
  sheetName: string;
  headerRow: number;
  headers: string[];
  rows: { row: number; cells: (string | number | null)[] }[];
  /** True when the sheet had more rows than we take in. */
  truncated?: boolean;
}

export interface PriceList {
  id: string;
  customerId: string;
  fileName: string;
  status: "draft" | "active" | "replaced";
  currency: string;
  mapping: PriceListMapping | null;
  /** The sheet as read; only while the list is a draft. */
  raw: PriceListRaw | null;
  itemCount: number;
  skipped: { row: number; reason: string }[];
  createdAt: Date;
  activatedAt: Date | null;
}

export interface PriceListItem {
  id: string;
  priceListId: string;
  position: number;
  code: string;
  name: string;
  unit: string;
  /** Net price in the smallest unit (grosz, cent). */
  netPriceCents: number;
  aliases: string[];
}

export interface NewPriceItem {
  position: number;
  code: string;
  name: string;
  unit: string;
  netPriceCents: number;
  aliases: string[];
}

export type OfferKind = "offer" | "order_confirmation";

export interface OfferLineRow {
  position: number;
  code: string;
  name: string;
  unit: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
}

/** An offer or order confirmation as it was made: its own lines and prices, independent of later price lists. */
export interface Offer {
  id: string;
  customerId: string;
  kind: OfferKind;
  number: string;
  threadId: string | null;
  messageId: string | null;
  sourceOfferId: string | null;
  priceListId: string | null;
  status: "prepared" | "accepted";
  recipientDomain: string;
  language: string;
  layout: OfferLayout;
  currency: string;
  vatRate: number;
  discountPercent: number;
  netCents: number;
  discountCents: number;
  vatCents: number;
  grossCents: number;
  /** YYYY-MM-DD */
  validUntil: string | null;
  storedPath: string | null;
  createdAt: Date;
  lines: OfferLineRow[];
}

export type NewOffer = Omit<Offer, "id" | "customerId" | "status" | "storedPath" | "createdAt"> & { createdAt?: Date };

export interface SenderDiscount {
  id: string;
  /** A domain or one address, lower case. */
  match: string;
  percent: number;
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
  sentDeltaLink: string | null;
  lastSyncAt: Date | null;
  lastError: string | null;
  /** What Microsoft granted at the last sign-in or token refresh, space-separated. */
  scopes: string;
  /** Short reason OneDrive could not be reached; null when filing works. */
  driveError: string | null;
  createdAt: Date;
}

/** Filing needs the app-folder permission; mailboxes connected before phase 2 get it by reconnecting once. */
export function canFile(connection: Pick<MailboxConnection, "provider" | "scopes">): boolean {
  return connection.provider === "microsoft" && /(^|\s)files\.readwrite\.appfolder(\s|$)/i.test(connection.scopes);
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
  /** The mail contains text that tries to instruct an automated assistant: no draft, listed in the brief. */
  suspicious: boolean;
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

export type DraftKind = "reply" | "chaser" | "order_confirmation" | "reminder";

export type InvoiceStatus =
  | "pending"
  | "open"
  | "needs_due_date"
  /** Read, but sent to someone who does not look like the buyer: the owner is asked once whether to track it. */
  | "needs_confirm"
  | "unreadable"
  | "not_ours"
  | "duplicate"
  | "paid"
  | "stopped";

/** An invoice the customer sent to one of their own customers, tracked for payment reminders. */
export interface Invoice {
  id: string;
  customerId: string;
  /** "sent" = seen in the mailbox's Sent Items; "forwarded" = the customer forwarded it to their Adminwise address. */
  source: "sent" | "forwarded";
  messageId: string | null;
  threadId: string | null;
  connectionId: string | null;
  fileName: string;
  contentHash: string;
  status: InvoiceStatus;
  number: string | null;
  language: string | null;
  debtorDomain: string;
  debtorName: string;
  amountCents: number | null;
  currency: string | null;
  /** YYYY-MM-DD */
  issueDate: string | null;
  dueDate: string | null;
  remindersMade: number;
  /** Customer-local date (YYYY-MM-DD) on which the next reminder was due but the previous one was still unsent. */
  reminderBlockedOn: string | null;
  lastReminderAt: Date | null;
  endedAt: Date | null;
  endedBy: "owner" | "sender" | null;
  /** Text read from a forwarded PDF, until the job has read it. */
  pendingText: string | null;
  createdAt: Date;
}
export type ChaseMode = "on" | "never" | "done";
export type DocType = "invoice" | "order" | "contract" | "offer" | "other";
export type FilingStatus = "filed" | "duplicate" | "queued" | "failed";

export interface Thread {
  id: string;
  customerId: string;
  subject: string;
  lastInboundAt: Date | null;
  lastOutboundAt: Date | null;
  chaseMode: ChaseMode;
  chaseHoldFrom: Date | null;
  /** Follow-up drafts written since the other party last answered... */
  chaserCount: number;
  /** ...and how many of those were skipped or deleted unsent. Only sent ones count toward the two. */
  chasersUnused: number;
  expectsReply: boolean | null;
  expectsReplyFor: string | null;
}

/** A thread where the customer wrote last, with the message a chaser would hang on. */
export interface ChaseCandidate extends Thread {
  lastOutboundAt: Date;
  messageId: string;
  providerMessageId: string;
  connectionId: string;
  /** Domain of the party the customer wrote to. */
  counterpartDomain: string;
}

/** One line of the "went quiet" section of the daily brief. */
export interface QuietThread {
  threadId: string;
  subject: string;
  counterpartDomain: string;
  lastOutboundAt: Date;
  /** True: a follow-up draft is waiting. False: two follow-ups were already written, so it is only listed. */
  chaserReady: boolean;
}

export interface FiledDocument {
  id: string;
  customerId: string;
  messageId: string | null;
  connectionId: string | null;
  providerMessageId: string;
  attachmentId: string;
  originalName: string;
  sizeBytes: number;
  contentHash: string | null;
  docType: DocType | null;
  senderFolder: string;
  status: FilingStatus;
  storedPath: string | null;
  driveItemId: string | null;
  duplicateOf: string | null;
  error: string | null;
  attempts: number;
  receivedAt: Date;
  filedAt: Date | null;
}

export interface Draft {
  id: string;
  customerId: string;
  messageId: string;
  threadId: string;
  kind: DraftKind;
  destination: DraftDestination;
  status: "pending" | "created" | "failed" | "closed";
  completedAt: Date | null;
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
  outcome: string | null;
}

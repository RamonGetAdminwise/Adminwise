import type { QueryResultRow } from "pg";
import { decrypt, encrypt } from "./crypto";
import { camel, type Db } from "./pool";
import type {
  Classification,
  ConnectionStatus,
  Customer,
  Draft,
  DraftDestination,
  DraftSummary,
  JobStatus,
  MailboxConnection,
  Message,
  NewMessage,
  Provider,
  User,
} from "./types";

/**
 * The customer-scoped data layer.
 *
 * Every query here goes through `run`, which always binds the customer id as $1
 * and refuses SQL that does not use it. Application code never writes SQL: it
 * calls `forCustomer(db, id)` and uses the methods below, so one customer's
 * data cannot be read or changed while working for another.
 */
export function forCustomer(db: Db, customerId: string) {
  async function run<R extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []) {
    if (!sql.includes("$1")) {
      throw new Error("Scoped query must filter on the customer id ($1)");
    }
    return db.pool.query<R>(sql, [customerId, ...params]);
  }

  function toConnection(row: QueryResultRow): MailboxConnection {
    const { accessTokenEnc, refreshTokenEnc, ...rest } = camel<
      MailboxConnection & { accessTokenEnc: string | null; refreshTokenEnc: string | null }
    >(row);
    return {
      ...rest,
      accessToken: accessTokenEnc ? decrypt(accessTokenEnc, db.encryptionKey) : null,
      refreshToken: refreshTokenEnc ? decrypt(refreshTokenEnc, db.encryptionKey) : null,
    };
  }

  return {
    customerId,

    // ---- customer and settings -------------------------------------------------

    async getCustomer(): Promise<Customer> {
      const { rows } = await run("SELECT * FROM customers WHERE id = $1");
      if (!rows[0]) throw new Error("Customer not found");
      return camel<Customer>(rows[0]);
    },

    async updateSettings(s: { name: string; languages: string[]; timeZone: string; signatureText: string }) {
      await run(
        "UPDATE customers SET name = $2, languages = $3, time_zone = $4, signature_text = $5 WHERE id = $1",
        [s.name, s.languages, s.timeZone, s.signatureText],
      );
    },

    async setVoiceProfile(profile: string) {
      await run("UPDATE customers SET voice_profile = $2 WHERE id = $1", [profile]);
    },

    /**
     * Marks the daily brief as sent for a customer-local date. Returns true only
     * for the first caller, so two workers can never send the same brief twice.
     */
    async claimBriefForDate(localDate: string): Promise<boolean> {
      const { rowCount } = await run(
        `UPDATE customers SET brief_last_sent_on = $2::date
         WHERE id = $1 AND (brief_last_sent_on IS NULL OR brief_last_sent_on < $2::date)`,
        [localDate],
      );
      return rowCount === 1;
    },

    /** Undo a claim when the brief could not be sent, so the next tick tries again. */
    async releaseBriefForDate(localDate: string) {
      await run(
        `UPDATE customers SET brief_last_sent_on = $2::date - 1
         WHERE id = $1 AND brief_last_sent_on = $2::date`,
        [localDate],
      );
    },

    async listUsers(): Promise<User[]> {
      const { rows } = await run("SELECT id, customer_id, email FROM users WHERE customer_id = $1 ORDER BY created_at");
      return rows.map((r) => camel<User>(r));
    },

    // ---- mailbox connections ---------------------------------------------------

    async upsertConnection(c: {
      provider: Provider;
      emailAddress: string;
      accessToken?: string;
      refreshToken?: string;
      tokenExpiresAt?: Date;
    }): Promise<MailboxConnection> {
      const { rows } = await run(
        `INSERT INTO mailbox_connections
           (customer_id, provider, email_address, status, access_token_enc, refresh_token_enc, token_expires_at)
         VALUES ($1, $2, $3, 'active', $4, $5, $6)
         ON CONFLICT (customer_id, provider) DO UPDATE SET
           email_address = EXCLUDED.email_address,
           status = 'active',
           access_token_enc = EXCLUDED.access_token_enc,
           refresh_token_enc = EXCLUDED.refresh_token_enc,
           token_expires_at = EXCLUDED.token_expires_at,
           last_error = NULL
         RETURNING *`,
        [
          c.provider,
          c.emailAddress,
          c.accessToken ? encrypt(c.accessToken, db.encryptionKey) : null,
          c.refreshToken ? encrypt(c.refreshToken, db.encryptionKey) : null,
          c.tokenExpiresAt ?? null,
        ],
      );
      return toConnection(rows[0]!);
    },

    async getConnection(id: string): Promise<MailboxConnection | null> {
      const { rows } = await run("SELECT * FROM mailbox_connections WHERE customer_id = $1 AND id = $2", [id]);
      return rows[0] ? toConnection(rows[0]) : null;
    },

    async getConnectionByProvider(provider: Provider): Promise<MailboxConnection | null> {
      const { rows } = await run("SELECT * FROM mailbox_connections WHERE customer_id = $1 AND provider = $2", [
        provider,
      ]);
      return rows[0] ? toConnection(rows[0]) : null;
    },

    async listConnections(): Promise<MailboxConnection[]> {
      const { rows } = await run("SELECT * FROM mailbox_connections WHERE customer_id = $1 ORDER BY created_at");
      return rows.map(toConnection);
    },

    async updateConnectionTokens(id: string, t: { accessToken: string; refreshToken: string; tokenExpiresAt: Date }) {
      await run(
        `UPDATE mailbox_connections
         SET access_token_enc = $3, refresh_token_enc = $4, token_expires_at = $5
         WHERE customer_id = $1 AND id = $2`,
        [id, encrypt(t.accessToken, db.encryptionKey), encrypt(t.refreshToken, db.encryptionKey), t.tokenExpiresAt],
      );
    },

    async setConnectionStatus(id: string, status: ConnectionStatus, lastError: string | null = null) {
      await run("UPDATE mailbox_connections SET status = $3, last_error = $4 WHERE customer_id = $1 AND id = $2", [
        id,
        status,
        lastError,
      ]);
    },

    async setSubscription(id: string, s: { subscriptionId: string; expiresAt: Date; clientState: string }) {
      await run(
        `UPDATE mailbox_connections
         SET subscription_id = $3, subscription_expires_at = $4, client_state = $5
         WHERE customer_id = $1 AND id = $2`,
        [id, s.subscriptionId, s.expiresAt, s.clientState],
      );
    },

    async markSynced(id: string, deltaLink: string | null) {
      await run(
        `UPDATE mailbox_connections
         SET delta_link = COALESCE($3, delta_link), last_sync_at = now()
         WHERE customer_id = $1 AND id = $2`,
        [id, deltaLink],
      );
    },

    // ---- threads and messages --------------------------------------------------

    /**
     * Stores a message once. Returns null when the same message (same dedupe key)
     * was already stored: the caller must then do nothing more.
     */
    async insertMessage(m: NewMessage): Promise<Message | null> {
      const thread = await run<{ id: string }>(
        `INSERT INTO threads (customer_id, provider_thread_id, subject, last_message_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (customer_id, provider_thread_id)
         DO UPDATE SET last_message_at = GREATEST(threads.last_message_at, EXCLUDED.last_message_at)
         RETURNING id`,
        [m.threadKey, m.subject, m.receivedAt],
      );
      const { rows } = await run(
        `INSERT INTO messages
           (customer_id, thread_id, connection_id, dedupe_key, provider_message_id, direction, sender_domain,
            from_address, subject, received_at, header_flags, attachment_names, body_text)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (customer_id, dedupe_key) DO NOTHING
         RETURNING *`,
        [
          thread.rows[0]!.id,
          m.connectionId,
          m.dedupeKey,
          m.providerMessageId,
          m.direction,
          m.senderDomain,
          m.fromAddress,
          m.subject,
          m.receivedAt,
          JSON.stringify(m.headerFlags),
          m.attachmentNames,
          m.bodyText,
        ],
      );
      return rows[0] ? camel<Message>(rows[0]) : null;
    },

    async getMessage(id: string): Promise<Message | null> {
      const { rows } = await run("SELECT * FROM messages WHERE customer_id = $1 AND id = $2", [id]);
      return rows[0] ? camel<Message>(rows[0]) : null;
    },

    /** Earlier messages of a thread, oldest first, for context when drafting. */
    async listThreadMessagesBefore(threadId: string, before: Date, limit = 10): Promise<Message[]> {
      const { rows } = await run(
        `SELECT * FROM (
           SELECT * FROM messages
           WHERE customer_id = $1 AND thread_id = $2 AND received_at < $3
           ORDER BY received_at DESC LIMIT $4
         ) recent ORDER BY received_at ASC`,
        [threadId, before, limit],
      );
      return rows.map((r) => camel<Message>(r));
    },

    async setClassification(messageId: string, classification: Classification, language: string | null) {
      await run("UPDATE messages SET classification = $3, language = $4 WHERE customer_id = $1 AND id = $2", [
        messageId,
        classification,
        language,
      ]);
    },

    // ---- drafts ----------------------------------------------------------------

    /**
     * Reserves the one reply draft that may exist for a message. Returns the draft
     * id for the caller that won, or null if a draft already exists or is being
     * written. A failed draft, or one stuck for 10 minutes, may be claimed again.
     */
    async claimDraft(d: {
      messageId: string;
      threadId: string;
      destination: DraftDestination;
      language: string | null;
      languageListed: boolean;
    }): Promise<string | null> {
      const { rows } = await run<{ id: string }>(
        `INSERT INTO drafts (customer_id, message_id, thread_id, destination, language, language_listed)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (customer_id, message_id, kind) DO UPDATE
           SET status = 'pending', created_at = now(), error = NULL
           WHERE drafts.status = 'failed'
              OR (drafts.status = 'pending' AND drafts.created_at < now() - interval '10 minutes')
         RETURNING id`,
        [d.messageId, d.threadId, d.destination, d.language, d.languageListed],
      );
      return rows[0]?.id ?? null;
    },

    async completeDraft(id: string, bodyText: string, providerDraftId: string | null) {
      await run(
        `UPDATE drafts SET status = 'created', body_text = $3, provider_draft_id = $4, completed_at = now()
         WHERE customer_id = $1 AND id = $2`,
        [id, bodyText, providerDraftId],
      );
    },

    async failDraft(id: string, error: string) {
      await run("UPDATE drafts SET status = 'failed', error = $3 WHERE customer_id = $1 AND id = $2", [id, error]);
    },

    async listDraftsForMessage(messageId: string): Promise<Draft[]> {
      const { rows } = await run("SELECT * FROM drafts WHERE customer_id = $1 AND message_id = $2", [messageId]);
      return rows.map((r) => camel<Draft>(r));
    },

    async countDrafts(): Promise<number> {
      const { rows } = await run<{ n: string }>("SELECT count(*) AS n FROM drafts WHERE customer_id = $1");
      return Number(rows[0]!.n);
    },

    /** Drafts finished in [from, to), with the metadata the daily brief shows. */
    async listDraftSummaries(from: Date, to: Date): Promise<DraftSummary[]> {
      const { rows } = await run(
        `SELECT d.id, m.subject, m.sender_domain, d.language, d.language_listed, d.destination
         FROM drafts d JOIN messages m ON m.id = d.message_id AND m.customer_id = d.customer_id
         WHERE d.customer_id = $1 AND d.status = 'created' AND d.completed_at >= $2 AND d.completed_at < $3
         ORDER BY d.completed_at`,
        [from, to],
      );
      return rows.map((r) => camel<DraftSummary>(r));
    },

    // ---- job log and audit -----------------------------------------------------

    async startJobRun(job: string, ref: string | null = null): Promise<string> {
      const { rows } = await run<{ id: string }>(
        "INSERT INTO job_runs (customer_id, job, ref) VALUES ($1, $2, $3) RETURNING id",
        [job, ref],
      );
      return rows[0]!.id;
    },

    async finishJobRun(
      id: string,
      result: { status: JobStatus; inputTokens?: number; outputTokens?: number; error?: string | null },
    ) {
      await run(
        `UPDATE job_runs SET status = $3, finished_at = now(), input_tokens = $4, output_tokens = $5, error = $6
         WHERE customer_id = $1 AND id = $2`,
        [id, result.status, result.inputTokens ?? 0, result.outputTokens ?? 0, result.error ?? null],
      );
    },

    async listJobRuns(limit = 50) {
      const { rows } = await run("SELECT * FROM job_runs WHERE customer_id = $1 ORDER BY started_at DESC LIMIT $2", [
        limit,
      ]);
      return rows.map((r) => camel<import("./types").JobRun>(r));
    },

    async audit(action: string, detail: Record<string, unknown> = {}, userId: string | null = null) {
      await run("INSERT INTO audit_events (customer_id, user_id, action, detail) VALUES ($1, $2, $3, $4)", [
        userId,
        action,
        JSON.stringify(detail),
      ]);
    },
  };
}

export type CustomerScope = ReturnType<typeof forCustomer>;

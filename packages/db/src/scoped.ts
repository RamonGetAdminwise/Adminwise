import type { QueryResultRow } from "pg";
import { decrypt, encrypt } from "./crypto";
import { camel, type Db } from "./pool";
import type {
  ChaseCandidate,
  ChaseMode,
  Classification,
  ConnectionStatus,
  Customer,
  DocType,
  Draft,
  DraftDestination,
  DraftKind,
  DraftSummary,
  FiledDocument,
  FilingStatus,
  JobStatus,
  QuietThread,
  Thread,
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

    async updateSettings(s: {
      name: string;
      languages: string[];
      timeZone: string;
      signatureText: string;
      /** Omitted = leave as it is. */
      followUpDays?: number;
    }) {
      await run(
        `UPDATE customers SET name = $2, languages = $3, time_zone = $4, signature_text = $5,
                follow_up_days = COALESCE($6, follow_up_days)
         WHERE id = $1`,
        [s.name, s.languages, s.timeZone, s.signatureText, s.followUpDays ?? null],
      );
    },

    /** Same idea as claimBriefForDate: the nightly chaser scan runs once per customer-local date. */
    async claimChaseForDate(localDate: string): Promise<boolean> {
      const { rowCount } = await run(
        `UPDATE customers SET chase_last_run_on = $2::date
         WHERE id = $1 AND (chase_last_run_on IS NULL OR chase_last_run_on < $2::date)`,
        [localDate],
      );
      return rowCount === 1;
    },

    async releaseChaseForDate(localDate: string) {
      await run(
        `UPDATE customers SET chase_last_run_on = $2::date - 1
         WHERE id = $1 AND chase_last_run_on = $2::date`,
        [localDate],
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
      /** Permissions Microsoft granted, space-separated. */
      scopes?: string;
    }): Promise<MailboxConnection> {
      const { rows } = await run(
        `INSERT INTO mailbox_connections
           (customer_id, provider, email_address, status, access_token_enc, refresh_token_enc, token_expires_at, scopes)
         VALUES ($1, $2, $3, 'active', $4, $5, $6, $7)
         ON CONFLICT (customer_id, provider) DO UPDATE SET
           email_address = EXCLUDED.email_address,
           status = 'active',
           access_token_enc = EXCLUDED.access_token_enc,
           refresh_token_enc = EXCLUDED.refresh_token_enc,
           token_expires_at = EXCLUDED.token_expires_at,
           scopes = EXCLUDED.scopes,
           last_error = NULL,
           drive_error = NULL,
           drive_error_at = NULL
         RETURNING *`,
        [
          c.provider,
          c.emailAddress,
          c.accessToken ? encrypt(c.accessToken, db.encryptionKey) : null,
          c.refreshToken ? encrypt(c.refreshToken, db.encryptionKey) : null,
          c.tokenExpiresAt ?? null,
          c.scopes ?? "",
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

    async updateConnectionTokens(
      id: string,
      t: { accessToken: string; refreshToken: string; tokenExpiresAt: Date; scopes?: string },
    ) {
      await run(
        `UPDATE mailbox_connections
         SET access_token_enc = $3, refresh_token_enc = $4, token_expires_at = $5,
             scopes = COALESCE(NULLIF($6::text, ''), scopes)
         WHERE customer_id = $1 AND id = $2`,
        [
          id,
          encrypt(t.accessToken, db.encryptionKey),
          encrypt(t.refreshToken, db.encryptionKey),
          t.tokenExpiresAt,
          t.scopes ?? "",
        ],
      );
    },

    async markSentSynced(id: string, deltaLink: string | null) {
      await run(
        `UPDATE mailbox_connections SET sent_delta_link = COALESCE($3, sent_delta_link)
         WHERE customer_id = $1 AND id = $2`,
        [id, deltaLink],
      );
    },

    /** Records that OneDrive could not be reached (shown to the customer), or clears it with null. */
    async setDriveError(id: string, error: string | null) {
      await run(
        `UPDATE mailbox_connections
         SET drive_error = $3, drive_error_at = CASE WHEN $3::text IS NULL THEN NULL ELSE now() END
         WHERE customer_id = $1 AND id = $2`,
        [id, error],
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
      if (!rows[0]) return null;

      // Who wrote last decides whether a follow-up is due. An automatic reply or
      // a mailing does not count as the other party answering.
      const automatic = Boolean(m.headerFlags.autoSubmitted || m.headerFlags.bulk || m.headerFlags.list);
      if (m.direction === "outbound") {
        await run(
          `UPDATE threads SET last_outbound_at = GREATEST(COALESCE(last_outbound_at, $3), $3)
           WHERE customer_id = $1 AND id = $2`,
          [thread.rows[0]!.id, m.receivedAt],
        );
      } else if (!automatic) {
        // The other party answered: the conversation is alive again.
        await run(
          `UPDATE threads SET last_inbound_at = GREATEST(COALESCE(last_inbound_at, $3), $3),
                  chaser_count = 0, chase_hold_from = NULL, went_quiet_on = NULL,
                  chase_mode = CASE WHEN chase_mode = 'done' THEN 'on' ELSE chase_mode END
           WHERE customer_id = $1 AND id = $2`,
          [thread.rows[0]!.id, m.receivedAt],
        );
      }
      if (m.direction === "outbound" || !automatic) {
        // A follow-up draft still waiting in this thread has been overtaken.
        await run(
          `UPDATE drafts SET status = 'closed'
           WHERE customer_id = $1 AND thread_id = $2 AND kind = 'chaser' AND status = 'created'
             AND completed_at < $3`,
          [thread.rows[0]!.id, m.receivedAt],
        );
      }
      return camel<Message>(rows[0]);
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
      /** "chaser" hangs on the customer's own last message; seq 1 or 2 is which follow-up it is. */
      kind?: DraftKind;
      seq?: number;
    }): Promise<string | null> {
      const { rows } = await run<{ id: string }>(
        `INSERT INTO drafts (customer_id, message_id, thread_id, destination, language, language_listed, kind, seq)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (customer_id, message_id, kind, seq) DO UPDATE
           SET status = 'pending', created_at = now(), error = NULL
           WHERE drafts.status = 'failed'
              OR (drafts.status = 'pending' AND drafts.created_at < now() - interval '10 minutes')
         RETURNING id`,
        [d.messageId, d.threadId, d.destination, d.language, d.languageListed, d.kind ?? "reply", d.seq ?? 1],
      );
      return rows[0]?.id ?? null;
    },

    async completeDraft(id: string, bodyText: string, providerDraftId: string | null, at: Date | null = null) {
      await run(
        `UPDATE drafts SET status = 'created', body_text = $3, provider_draft_id = $4,
                completed_at = COALESCE($5::timestamptz, now())
         WHERE customer_id = $1 AND id = $2`,
        [id, bodyText, providerDraftId, at],
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
         WHERE d.customer_id = $1 AND d.kind = 'reply' AND d.status = 'created'
           AND d.completed_at >= $2 AND d.completed_at < $3
         ORDER BY d.completed_at`,
        [from, to],
      );
      return rows.map((r) => camel<DraftSummary>(r));
    },

    // ---- follow-up chaser ------------------------------------------------------

    async getThread(id: string): Promise<Thread | null> {
      const { rows } = await run("SELECT * FROM threads WHERE customer_id = $1 AND id = $2", [id]);
      return rows[0] ? camel<Thread>(rows[0]) : null;
    },

    /**
     * Threads where the customer wrote last and following up is still allowed,
     * each with the customer's last message (the one a chaser replies to).
     * Whether the follow-up period has passed is decided by the caller, in
     * working days of the customer's time zone.
     */
    async listChaseCandidates(notOlderThan: Date): Promise<ChaseCandidate[]> {
      const { rows } = await run(
        `SELECT t.*, m.id AS message_id, m.provider_message_id, m.connection_id, m.sender_domain AS counterpart_domain
         FROM threads t
         JOIN LATERAL (
           SELECT id, provider_message_id, connection_id, sender_domain FROM messages
           WHERE customer_id = t.customer_id AND thread_id = t.id AND direction = 'outbound'
           ORDER BY received_at DESC LIMIT 1
         ) m ON true
         JOIN mailbox_connections c ON c.id = m.connection_id AND c.customer_id = t.customer_id
         WHERE t.customer_id = $1 AND t.chase_mode = 'on'
           AND t.last_outbound_at IS NOT NULL AND t.last_outbound_at >= $2
           AND (t.last_inbound_at IS NULL OR t.last_inbound_at < t.last_outbound_at)
           AND c.provider = 'microsoft' AND c.status = 'active'
         ORDER BY t.last_outbound_at`,
        [notOlderThan],
      );
      return rows.map((r) => camel<ChaseCandidate>(r));
    },

    /** Remembers the answer to "does this message expect a reply?" so the model is asked once per message. */
    async setChaseVerdict(threadId: string, messageId: string, expectsReply: boolean) {
      await run(
        "UPDATE threads SET expects_reply = $3, expects_reply_for = $4 WHERE customer_id = $1 AND id = $2",
        [threadId, expectsReply, messageId],
      );
    },

    /** A follow-up was drafted: count it and start the next follow-up period now. */
    async recordChaser(threadId: string, at: Date) {
      await run(
        `UPDATE threads SET chaser_count = chaser_count + 1, chase_hold_from = $3
         WHERE customer_id = $1 AND id = $2`,
        [threadId, at],
      );
    },

    /** "Not this time": ask again after another follow-up period. */
    async snoozeChase(threadId: string, at: Date) {
      await run("UPDATE threads SET chase_hold_from = $3 WHERE customer_id = $1 AND id = $2", [threadId, at]);
    },

    /** "Never for this thread", or "done" once two follow-ups were used. */
    async setChaseMode(threadId: string, mode: ChaseMode) {
      await run("UPDATE threads SET chase_mode = $3 WHERE customer_id = $1 AND id = $2", [threadId, mode]);
    },

    /** Two follow-ups brought no answer: list the thread once in the brief, then leave it alone. */
    async markWentQuiet(threadId: string, localDate: string) {
      await run(
        "UPDATE threads SET went_quiet_on = $3::date, chase_mode = 'done' WHERE customer_id = $1 AND id = $2",
        [threadId, localDate],
      );
    },

    /** The follow-up draft still waiting in a thread, if any. */
    async getOpenChaser(threadId: string): Promise<Draft | null> {
      const { rows } = await run(
        `SELECT * FROM drafts
         WHERE customer_id = $1 AND thread_id = $2 AND kind = 'chaser' AND status = 'created'
         ORDER BY completed_at DESC LIMIT 1`,
        [threadId],
      );
      return rows[0] ? camel<Draft>(rows[0]) : null;
    },

    async listOpenChasers(): Promise<Draft[]> {
      const { rows } = await run(
        "SELECT * FROM drafts WHERE customer_id = $1 AND kind = 'chaser' AND status = 'created' ORDER BY completed_at",
      );
      return rows.map((r) => camel<Draft>(r));
    },

    async closeDraft(id: string) {
      await run("UPDATE drafts SET status = 'closed' WHERE customer_id = $1 AND id = $2", [id]);
    },

    /**
     * The "went quiet" section of the brief for one customer-local day: threads
     * that got a follow-up draft since `since`, and threads listed on `localDate`
     * because two follow-ups were already used.
     */
    async listQuietThreads(since: Date, localDate: string): Promise<QuietThread[]> {
      const { rows } = await run(
        `SELECT t.id AS thread_id, t.subject, m.sender_domain AS counterpart_domain, t.last_outbound_at,
                true AS chaser_ready
         FROM drafts d
         JOIN threads t ON t.id = d.thread_id AND t.customer_id = d.customer_id
         JOIN messages m ON m.id = d.message_id AND m.customer_id = d.customer_id
         WHERE d.customer_id = $1 AND d.kind = 'chaser' AND d.status = 'created' AND d.completed_at >= $2
         UNION ALL
         SELECT t.id, t.subject,
                COALESCE((SELECT sender_domain FROM messages
                          WHERE customer_id = t.customer_id AND thread_id = t.id AND direction = 'outbound'
                          ORDER BY received_at DESC LIMIT 1), ''),
                t.last_outbound_at, false
         FROM threads t
         WHERE t.customer_id = $1 AND t.went_quiet_on = $3::date
         ORDER BY last_outbound_at`,
        [since, localDate],
      );
      return rows.map((r) => camel<QuietThread>(r));
    },

    // ---- filing ----------------------------------------------------------------

    async getFiledDocument(providerMessageId: string, attachmentId: string): Promise<FiledDocument | null> {
      const { rows } = await run(
        "SELECT * FROM filed_documents WHERE customer_id = $1 AND provider_message_id = $2 AND attachment_id = $3",
        [providerMessageId, attachmentId],
      );
      return rows[0] ? camel<FiledDocument>(rows[0]) : null;
    },

    /** The already filed copy of a file with this content, if there is one. */
    async findFiledByHash(contentHash: string): Promise<FiledDocument | null> {
      const { rows } = await run(
        "SELECT * FROM filed_documents WHERE customer_id = $1 AND content_hash = $2 AND status = 'filed'",
        [contentHash],
      );
      return rows[0] ? camel<FiledDocument>(rows[0]) : null;
    },

    /** One row per attachment; a later attempt for the same attachment updates it. */
    async saveFiledDocument(d: {
      messageId: string | null;
      connectionId: string;
      providerMessageId: string;
      attachmentId: string;
      originalName: string;
      sizeBytes: number;
      contentHash: string | null;
      docType: DocType | null;
      senderFolder: string;
      status: FilingStatus;
      storedPath?: string | null;
      driveItemId?: string | null;
      duplicateOf?: string | null;
      error?: string | null;
      receivedAt: Date;
      /** When it happened; defaults to now. */
      at?: Date;
    }): Promise<void> {
      await run(
        `INSERT INTO filed_documents
           (customer_id, message_id, connection_id, provider_message_id, attachment_id, original_name, size_bytes,
            content_hash, doc_type, sender_folder, status, stored_path, drive_item_id, duplicate_of, error,
            received_at, attempts, last_attempt_at, filed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 1, $17::timestamptz,
                 CASE WHEN $11::text = 'filed' THEN $17::timestamptz END)
         ON CONFLICT (customer_id, provider_message_id, attachment_id) DO UPDATE SET
           content_hash = COALESCE(EXCLUDED.content_hash, filed_documents.content_hash),
           doc_type = COALESCE(EXCLUDED.doc_type, filed_documents.doc_type),
           status = EXCLUDED.status,
           stored_path = EXCLUDED.stored_path,
           drive_item_id = EXCLUDED.drive_item_id,
           duplicate_of = EXCLUDED.duplicate_of,
           error = EXCLUDED.error,
           attempts = filed_documents.attempts + 1,
           last_attempt_at = EXCLUDED.last_attempt_at,
           filed_at = COALESCE(EXCLUDED.filed_at, filed_documents.filed_at)`,
        [
          d.messageId,
          d.connectionId,
          d.providerMessageId,
          d.attachmentId,
          d.originalName,
          d.sizeBytes,
          d.contentHash,
          d.docType,
          d.senderFolder,
          d.status,
          d.storedPath ?? null,
          d.driveItemId ?? null,
          d.duplicateOf ?? null,
          d.error ?? null,
          d.receivedAt,
          d.at ?? new Date(),
        ],
      );
    },

    /** Documents filed in [from, to), for the daily brief. */
    async listFiledBetween(from: Date, to: Date): Promise<FiledDocument[]> {
      const { rows } = await run(
        `SELECT * FROM filed_documents
         WHERE customer_id = $1 AND status = 'filed' AND filed_at >= $2 AND filed_at < $3
         ORDER BY filed_at`,
        [from, to],
      );
      return rows.map((r) => camel<FiledDocument>(r));
    },

    async countQueuedFiling(): Promise<number> {
      const { rows } = await run<{ n: string }>(
        "SELECT count(*) AS n FROM filed_documents WHERE customer_id = $1 AND status = 'queued'",
      );
      return Number(rows[0]!.n);
    },

    /** Messages with attachments still waiting for OneDrive, last tried before `before`. */
    async listQueuedFilingMessageIds(connectionId: string, before: Date, limit = 20): Promise<string[]> {
      const { rows } = await run<{ message_id: string }>(
        `SELECT DISTINCT message_id FROM filed_documents
         WHERE customer_id = $1 AND connection_id = $2 AND status = 'queued' AND message_id IS NOT NULL
           AND last_attempt_at < $3
         LIMIT $4`,
        [connectionId, before, limit],
      );
      return rows.map((r) => r.message_id);
    },

    /** How many runs of a job ended with a given outcome in [from, to). */
    async countJobOutcomes(job: string, outcome: string, from: Date, to: Date): Promise<number> {
      const { rows } = await run<{ n: string }>(
        `SELECT count(*) AS n FROM job_runs
         WHERE customer_id = $1 AND job = $2 AND outcome = $3 AND started_at >= $4 AND started_at < $5`,
        [job, outcome, from, to],
      );
      return Number(rows[0]!.n);
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
      result: {
        status: JobStatus;
        inputTokens?: number;
        outputTokens?: number;
        error?: string | null;
        /** Short fixed code for what happened ("drafted", "no_draft:newsletter"); never mail content. */
        outcome?: string | null;
      },
    ) {
      await run(
        `UPDATE job_runs SET status = $3, finished_at = now(), input_tokens = $4, output_tokens = $5, error = $6,
                outcome = $7
         WHERE customer_id = $1 AND id = $2`,
        [
          id,
          result.status,
          result.inputTokens ?? 0,
          result.outputTokens ?? 0,
          result.error ?? null,
          result.outcome ?? null,
        ],
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

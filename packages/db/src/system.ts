import { camel, type Db } from "./pool";
import type { Provider, SessionInfo } from "./types";

/**
 * Queries that are not tied to one customer: sign-in, routing an incoming
 * webhook to its customer, and the schedulers that fan out per customer.
 * Apart from sign-in and the account mails (which need an email address), they
 * return ids and routing data only; all customer data is then read through
 * forCustomer().
 */
export function system(db: Db) {
  return {
    // ---- sign-in ---------------------------------------------------------------

    async createLoginToken(email: string, tokenHash: string, expiresAt: Date) {
      await db.pool.query("INSERT INTO login_tokens (email, token_hash, expires_at) VALUES ($1, $2, $3)", [
        email,
        tokenHash,
        expiresAt,
      ]);
    },

    /** Single use: returns the email once, then never again. */
    async consumeLoginToken(tokenHash: string): Promise<string | null> {
      const { rows } = await db.pool.query<{ email: string }>(
        `UPDATE login_tokens SET used_at = now()
         WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
         RETURNING email`,
        [tokenHash],
      );
      return rows[0]?.email ?? null;
    },

    /** Whose link this is, without using it up (shown on the "sign in as ..." page). Null when it is no longer valid. */
    async peekLoginToken(tokenHash: string): Promise<string | null> {
      const { rows } = await db.pool.query<{ email: string }>(
        "SELECT email FROM login_tokens WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()",
        [tokenHash],
      );
      return rows[0]?.email ?? null;
    },

    async findUserByEmail(email: string): Promise<{ id: string; customerId: string } | null> {
      const { rows } = await db.pool.query("SELECT id, customer_id FROM users WHERE email = $1", [email]);
      return rows[0] ? camel(rows[0]) : null;
    },

    /** New sign-up: a customer, its first user and its forwarding-address connection, in one transaction. */
    async createCustomerWithUser(input: {
      email: string;
      slug: string;
      name?: string;
      timeZone?: string;
      briefStartDate?: string;
    }): Promise<{ userId: string; customerId: string }> {
      const client = await db.pool.connect();
      try {
        await client.query("BEGIN");
        const customer = await client.query<{ id: string }>(
          `INSERT INTO customers (name, slug, time_zone, brief_last_sent_on)
           VALUES ($1, $2, COALESCE($3, 'Europe/Warsaw'), $4::date) RETURNING id`,
          [input.name ?? "", input.slug, input.timeZone ?? null, input.briefStartDate ?? null],
        );
        const customerId = customer.rows[0]!.id;
        const user = await client.query<{ id: string }>(
          "INSERT INTO users (customer_id, email) VALUES ($1, $2) RETURNING id",
          [customerId, input.email],
        );
        await client.query(
          "INSERT INTO mailbox_connections (customer_id, provider, email_address) VALUES ($1, 'forwarding', $2)",
          [customerId, input.slug],
        );
        await client.query("COMMIT");
        return { userId: user.rows[0]!.id, customerId };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async slugExists(slug: string): Promise<boolean> {
      const { rowCount } = await db.pool.query("SELECT 1 FROM customers WHERE slug = $1", [slug]);
      return rowCount === 1;
    },

    async createSession(userId: string, customerId: string, tokenHash: string, expiresAt: Date) {
      await db.pool.query(
        "INSERT INTO sessions (user_id, customer_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)",
        [userId, customerId, tokenHash, expiresAt],
      );
    },

    async findSession(tokenHash: string): Promise<SessionInfo | null> {
      const { rows } = await db.pool.query(
        `SELECT s.user_id, s.customer_id, u.email
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.expires_at > now()`,
        [tokenHash],
      );
      return rows[0] ? camel<SessionInfo>(rows[0]) : null;
    },

    async deleteSession(tokenHash: string) {
      await db.pool.query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash]);
    },

    // ---- routing ---------------------------------------------------------------

    async findCustomerIdBySlug(slug: string): Promise<string | null> {
      const { rows } = await db.pool.query<{ id: string }>("SELECT id FROM customers WHERE slug = $1", [slug]);
      return rows[0]?.id ?? null;
    },

    /** Which customer and connection a Graph notification belongs to. */
    async findConnectionBySubscription(
      subscriptionId: string,
    ): Promise<{ id: string; customerId: string; clientState: string | null } | null> {
      const { rows } = await db.pool.query(
        "SELECT id, customer_id, client_state FROM mailbox_connections WHERE subscription_id = $1",
        [subscriptionId],
      );
      return rows[0] ? camel(rows[0]) : null;
    },

    // ---- schedulers ------------------------------------------------------------

    async listConnectionRefs(provider: Provider): Promise<{ id: string; customerId: string }[]> {
      const { rows } = await db.pool.query(
        "SELECT id, customer_id FROM mailbox_connections WHERE provider = $1 AND status = 'active'",
        [provider],
      );
      return rows.map((r) => camel(r));
    },

    /** Each customer's time zone and the local date their last daily brief was for (YYYY-MM-DD or null). */
    async listCustomerClocks(): Promise<
      {
        id: string;
        timeZone: string;
        briefLastSentOn: string | null;
        chaseLastRunOn: string | null;
        remindLastRunOn: string | null;
        plan: "start" | "run";
        billingStatus: "trial" | "active" | "read_only" | "internal";
        trialEndsAt: Date;
      }[]
    > {
      const { rows } = await db.pool.query(
        `SELECT id, time_zone, brief_last_sent_on::text AS brief_last_sent_on,
                chase_last_run_on::text AS chase_last_run_on, remind_last_run_on::text AS remind_last_run_on,
                plan, billing_status, trial_ends_at
         FROM customers`,
      );
      return rows.map((r) => camel(r));
    },

    // ---- trial and read-only accounts -----------------------------------------
    // Each step is two calls: list who is due, then mark one account once its mail has gone out.
    // A mail that could not be sent is therefore tried again next hour, never silently skipped.

    /**
     * While billing is switched off no trial runs out: every trial keeps its full length ahead of it.
     * On the day billing is switched on, each account then still has the whole trial and gets its reminder.
     */
    async holdTrialClocks(now: Date, trialDays: number): Promise<number> {
      const { rowCount } = await db.pool.query(
        `UPDATE customers SET trial_ends_at = $1::timestamptz + make_interval(days => $2), trial_reminder_sent_at = NULL
         WHERE billing_status = 'trial' AND trial_ends_at < $1::timestamptz + make_interval(days => $2) - interval '1 hour'`,
        [now, trialDays],
      );
      return rowCount ?? 0;
    },

    /** Trials ending at or before `before` that have not had their reminder. */
    async listTrialReminders(before: Date, now: Date): Promise<{ id: string; trialEndsAt: Date }[]> {
      const { rows } = await db.pool.query(
        `SELECT id, trial_ends_at FROM customers
         WHERE billing_status = 'trial' AND trial_reminder_sent_at IS NULL AND trial_ends_at <= $1 AND trial_ends_at > $2`,
        [before, now],
      );
      return rows.map((r) => camel(r));
    },

    async markTrialReminderSent(customerId: string, now: Date) {
      await db.pool.query("UPDATE customers SET trial_reminder_sent_at = $2 WHERE id = $1 AND billing_status = 'trial'", [customerId, now]);
    },

    /** Trials that have run out and are not yet marked read-only. (They already count as read-only: see entitlements.) */
    async listExpiredTrials(now: Date): Promise<{ id: string }[]> {
      const { rows } = await db.pool.query("SELECT id FROM customers WHERE billing_status = 'trial' AND trial_ends_at <= $1", [now]);
      return rows.map((r) => ({ id: r.id as string }));
    },

    /** Makes one run-out trial read-only from `now`. False when it is no longer a run-out trial (it subscribed meanwhile). */
    async endTrial(customerId: string, now: Date): Promise<boolean> {
      const { rowCount } = await db.pool.query(
        `UPDATE customers SET billing_status = 'read_only', read_only_since = $2
         WHERE id = $1 AND billing_status = 'trial' AND trial_ends_at <= $2`,
        [customerId, now],
      );
      return (rowCount ?? 0) > 0;
    },

    /** Accounts read-only since `since` or longer that have not been warned about deletion. */
    async listDeletionWarnings(since: Date): Promise<{ id: string; readOnlySince: Date }[]> {
      const { rows } = await db.pool.query(
        `SELECT id, read_only_since FROM customers
         WHERE billing_status = 'read_only' AND deletion_warning_sent_at IS NULL AND read_only_since <= $1`,
        [since],
      );
      return rows.map((r) => camel(r));
    },

    /** The warning mail has gone out: the week until deletion counts from `now`. */
    async markDeletionWarned(customerId: string, now: Date) {
      await db.pool.query(
        "UPDATE customers SET deletion_warning_sent_at = $2 WHERE id = $1 AND billing_status = 'read_only' AND deletion_warning_sent_at IS NULL",
        [customerId, now],
      );
    },

    /** Read-only accounts due for deletion: read-only since `since` or longer AND warned at `warnedBefore` or earlier. */
    async listAccountsToDelete(since: Date, warnedBefore: Date): Promise<string[]> {
      const { rows } = await db.pool.query(
        `SELECT id FROM customers
         WHERE billing_status = 'read_only' AND read_only_since <= $1 AND deletion_warning_sent_at <= $2`,
        [since, warnedBefore],
      );
      return rows.map((r) => r.id as string);
    },

    /**
     * Brings an account in step with its subscription as Stripe reports it now.
     * Safe to call any number of times and in any order of events:
     *   - a running subscription (also while a failed payment is being retried)
     *     makes the account active on that plan and clears the read-only clock;
     *     a price we do not recognise gives the smaller plan, never silently the larger;
     *   - an ended one makes it read-only, but only if it is the subscription the
     *     account is on, so a late event about an old subscription changes nothing;
     *   - our own ("internal") accounts keep their status.
     * Returns the customer id, or null when no account belongs to that Stripe customer.
     */
    async applySubscription(
      sub: {
        id: string;
        stripeCustomerId: string;
        live: boolean;
        plan: "start" | "run" | null;
        currentPeriodEnd: Date | null;
        cancelAtPeriodEnd: boolean;
      },
      now: Date = new Date(),
    ): Promise<string | null> {
      if (sub.live) {
        const { rows } = await db.pool.query(
          `UPDATE customers SET
             billing_status = CASE WHEN billing_status = 'internal' THEN 'internal' ELSE 'active' END,
             plan = COALESCE($3, 'start'), stripe_subscription_id = $2, current_period_end = $4, cancel_at_period_end = $5,
             read_only_since = NULL, deletion_warning_sent_at = NULL
           WHERE stripe_customer_id = $1 RETURNING id`,
          [sub.stripeCustomerId, sub.id, sub.plan, sub.currentPeriodEnd, sub.cancelAtPeriodEnd],
        );
        return (rows[0]?.id as string | undefined) ?? null;
      }
      const { rows } = await db.pool.query(
        `UPDATE customers SET
           billing_status = CASE WHEN billing_status = 'active' THEN 'read_only' ELSE billing_status END,
           read_only_since = CASE WHEN billing_status = 'active' THEN $3 ELSE read_only_since END,
           cancel_at_period_end = false
         WHERE stripe_customer_id = $1 AND stripe_subscription_id = $2 RETURNING id`,
        [sub.stripeCustomerId, sub.id, now],
      );
      return (rows[0]?.id as string | undefined) ?? null;
    },

    async listUserEmails(customerId: string): Promise<string[]> {
      const { rows } = await db.pool.query("SELECT email FROM users WHERE customer_id = $1 ORDER BY created_at", [customerId]);
      return rows.map((r) => r.email as string);
    },

    /**
     * Deletes a customer and everything stored for them: every table hangs off
     * customers with ON DELETE CASCADE. Files in the customer's own OneDrive and
     * drafts in their own mailbox are theirs and stay where they are.
     * `onlyIfReadOnly` guards the automatic clean-up: an account that paid in
     * the meantime is not touched.
     */
    async deleteCustomer(customerId: string, onlyIfReadOnly = false): Promise<boolean> {
      const client = await db.pool.connect();
      try {
        await client.query("BEGIN");
        // Sign-in links are kept by email address, not by customer: collect the addresses first.
        const users = await client.query<{ email: string }>("SELECT email FROM users WHERE customer_id = $1", [customerId]);
        const { rowCount } = await client.query(
          `DELETE FROM customers WHERE id = $1 AND ($2::boolean = false OR billing_status = 'read_only')`,
          [customerId, onlyIfReadOnly],
        );
        const deleted = (rowCount ?? 0) > 0;
        if (deleted && users.rows.length > 0) {
          await client.query("DELETE FROM login_tokens WHERE email = ANY($1::text[])", [users.rows.map((u) => u.email)]);
        }
        await client.query("COMMIT");
        return deleted;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    /**
     * Housekeeping, hourly: sign-in links and sessions that have expired, and the
     * record of routine runs older than `keepDays` (failed runs are kept twice as long).
     */
    async prune(now: Date, keepDays: number): Promise<void> {
      await db.pool.query("DELETE FROM login_tokens WHERE expires_at < $1::timestamptz - interval '1 day'", [now]);
      await db.pool.query("DELETE FROM sessions WHERE expires_at < $1", [now]);
      await db.pool.query(
        `DELETE FROM job_runs
         WHERE started_at < $1::timestamptz - make_interval(days => CASE WHEN status = 'failed' THEN $2 * 2 ELSE $2 END)`,
        [now, keepDays],
      );
    },

    /** How many sign-in links were requested for this address since `since`. */
    async countLoginTokens(email: string, since: Date): Promise<number> {
      const { rows } = await db.pool.query<{ n: string }>(
        "SELECT count(*) AS n FROM login_tokens WHERE email = $1 AND created_at >= $2",
        [email, since],
      );
      return Number(rows[0]!.n);
    },

    /**
     * Inbound mail that was stored but never handled: its job was never queued (a crash between
     * storing and queueing), or every retry failed. Only mail that still has its text, with no run
     * that finished or that started after `quietSince`, and not tried more than `maxRuns` times.
     */
    async listUnhandledMessages(
      storedBefore: Date,
      storedAfter: Date,
      quietSince: Date,
      maxRuns: number,
    ): Promise<{ customerId: string; messageId: string }[]> {
      const { rows } = await db.pool.query(
        `SELECT m.customer_id, m.id AS message_id FROM messages m
         WHERE m.direction = 'inbound' AND m.body_text IS NOT NULL AND m.created_at < $1 AND m.created_at > $2
           AND NOT EXISTS (
             SELECT 1 FROM job_runs r
             WHERE r.customer_id = m.customer_id AND r.job = 'reply-draft' AND r.ref = m.id::text
               AND (r.status IN ('succeeded', 'skipped') OR r.started_at > $3))
           AND (SELECT count(*) FROM job_runs r
                WHERE r.customer_id = m.customer_id AND r.job = 'reply-draft' AND r.ref = m.id::text) < $4
         ORDER BY m.created_at LIMIT 200`,
        [storedBefore, storedAfter, quietSince, maxRuns],
      );
      return rows.map((r) => camel(r));
    },

    /**
     * Failed runs of the once-a-day jobs since `since`, per customer, job and day:
     * how often, and when last. The schedulers use it to wait longer after each failure.
     */
    async dailyFailures(since: Date): Promise<Map<string, { count: number; last: Date }>> {
      const { rows } = await db.pool.query<{ customer_id: string; job: string; ref: string; n: string; last: Date }>(
        `SELECT customer_id, job, ref, count(*) AS n, max(finished_at) AS last FROM job_runs
         WHERE status = 'failed' AND started_at >= $1 AND job IN ('chaser', 'payment-reminders', 'daily-brief')
           AND customer_id IS NOT NULL AND ref IS NOT NULL
         GROUP BY 1, 2, 3`,
        [since],
      );
      return new Map(rows.map((r) => [`${r.customer_id}|${r.job}|${r.ref}`, { count: Number(r.n), last: r.last }]));
    },

    // ---- operator alerts -------------------------------------------------------

    /**
     * Failed job runs since `since`, counted per customer, job and error type.
     * The error type is the error's class name only (the text before the first
     * colon), so nothing a customer or their mail wrote can end up in an alert.
     */
    async failureSummary(since: Date): Promise<{ customerId: string | null; job: string; errorType: string; count: number }[]> {
      const { rows } = await db.pool.query<{ customer_id: string | null; job: string; error_type: string; n: string }>(
        `SELECT customer_id, job, split_part(COALESCE(error, ''), ':', 1) AS error_type, count(*) AS n
         FROM job_runs
         WHERE status = 'failed' AND finished_at >= $1 AND job <> 'operator-alert'
         GROUP BY 1, 2, 3
         ORDER BY n DESC, job`,
        [since],
      );
      return rows.map((r) => ({
        customerId: r.customer_id,
        job: r.job,
        errorType: /^[A-Za-z]{1,40}$/.test(r.error_type) ? r.error_type : "Error",
        count: Number(r.n),
      }));
    },

    /**
     * Queue health straight from pg-boss's own table: jobs that should have
     * started more than `stuckMinutes` ago, and jobs that failed for good since
     * `since`. Returns nothing when the queue schema is not there (unit tests).
     */
    async queueProblems(since: Date, stuckMinutes: number): Promise<{ queue: string; stuck: number; failed: number }[]> {
      try {
        const { rows } = await db.pool.query<{ name: string; stuck: string; failed: string }>(
          `SELECT name,
                  count(*) FILTER (WHERE state IN ('created', 'retry')
                                   AND start_after < now() - make_interval(mins => $2)) AS stuck,
                  count(*) FILTER (WHERE state = 'failed' AND completed_on >= $1) AS failed
           FROM pgboss.job
           GROUP BY name`,
          [since, stuckMinutes],
        );
        return rows
          .map((r) => ({ queue: r.name, stuck: Number(r.stuck), failed: Number(r.failed) }))
          .filter((r) => r.stuck > 0 || r.failed > 0);
      } catch (error) {
        // 3F000 = schema missing, 42P01 = table missing, 42703 = column missing (queue not started or changed)
        const code = (error as { code?: string }).code;
        if (code === "3F000" || code === "42P01" || code === "42703") return [];
        throw error;
      }
    },

    /**
     * The 24-hour rule: empties email bodies, sender addresses and generated
     * draft text older than `maxAgeHours`. Metadata rows stay.
     */
    async purgeBodies(maxAgeHours: number, now: Date = new Date()): Promise<{ messages: number; drafts: number }> {
      const cutoff = new Date(now.getTime() - maxAgeHours * 3_600_000);
      const messages = await db.pool.query(
        `UPDATE messages SET body_text = NULL, from_address = NULL, body_purged_at = now()
         WHERE body_purged_at IS NULL AND created_at < $1`,
        [cutoff],
      );
      const drafts = await db.pool.query(
        `UPDATE drafts SET body_text = NULL, body_purged_at = now()
         WHERE body_purged_at IS NULL AND created_at < $1`,
        [cutoff],
      );
      // Text read from a forwarded invoice that was never processed must not linger either.
      await db.pool.query("UPDATE invoices SET pending_text = NULL WHERE pending_text IS NOT NULL AND created_at < $1", [
        cutoff,
      ]);
      return { messages: messages.rowCount ?? 0, drafts: drafts.rowCount ?? 0 };
    },

    async startJobRun(job: string): Promise<string> {
      const { rows } = await db.pool.query<{ id: string }>("INSERT INTO job_runs (job) VALUES ($1) RETURNING id", [
        job,
      ]);
      return rows[0]!.id;
    },

    async finishJobRun(id: string, status: "succeeded" | "failed", error: string | null = null) {
      await db.pool.query(
        "UPDATE job_runs SET status = $2, finished_at = now(), error = $3 WHERE id = $1 AND customer_id IS NULL",
        [id, status, error],
      );
    },

    /** A service says "I am alive". One row per service, overwritten each time. */
    async beat(name: string, at: Date) {
      await db.pool.query(
        `INSERT INTO heartbeats (name, beat_at) VALUES ($1, $2)
         ON CONFLICT (name) DO UPDATE SET beat_at = GREATEST(heartbeats.beat_at, EXCLUDED.beat_at)`,
        [name, at],
      );
    },

    /** When a service last said it was alive; null when it never did. */
    async lastBeat(name: string): Promise<Date | null> {
      const { rows } = await db.pool.query<{ beat_at: Date }>("SELECT beat_at FROM heartbeats WHERE name = $1", [name]);
      return rows[0]?.beat_at ?? null;
    },

    async ping(): Promise<boolean> {
      await db.pool.query("SELECT 1");
      return true;
    },
  };
}

export type SystemScope = ReturnType<typeof system>;

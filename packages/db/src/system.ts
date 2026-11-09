import { camel, type Db } from "./pool";
import type { Provider, SessionInfo } from "./types";

/**
 * Queries that are not tied to one customer: sign-in, routing an incoming
 * webhook to its customer, and the schedulers that fan out per customer.
 * They return ids and routing data only; all customer data is then read
 * through forCustomer().
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
    async listCustomerClocks(): Promise<{ id: string; timeZone: string; briefLastSentOn: string | null }[]> {
      const { rows } = await db.pool.query(
        "SELECT id, time_zone, brief_last_sent_on::text AS brief_last_sent_on FROM customers",
      );
      return rows.map((r) => camel(r));
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

    async ping(): Promise<boolean> {
      await db.pool.query("SELECT 1");
      return true;
    },
  };
}

export type SystemScope = ReturnType<typeof system>;

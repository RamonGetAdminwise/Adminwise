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
  Invoice,
  InvoiceStatus,
  JobStatus,
  OfferProposal,
  QuietThread,
  ReplyDraftMode,
  Thread,
  MailboxConnection,
  Message,
  NewMessage,
  NewOffer,
  NewPriceItem,
  Offer,
  OfferKind,
  OfferSettings,
  PriceList,
  PriceListItem,
  PriceListMapping,
  PriceListRaw,
  Provider,
  SenderDiscount,
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

  function toPriceList(row: QueryResultRow): PriceList {
    const list = camel<PriceList>(row);
    // An empty mapping object means "not found yet".
    const mapping = list.mapping && "name" in list.mapping ? list.mapping : null;
    return { ...list, mapping };
  }

  /** An offer with its lines as one JSON column, so one query returns the whole document. */
  const OFFER_SELECT = `
    SELECT o.*, o.valid_until::text AS valid_until,
           COALESCE((SELECT jsonb_agg(jsonb_build_object(
                       'position', l.position, 'code', l.code, 'name', l.name, 'unit', l.unit,
                       'quantity', l.quantity, 'unitPriceCents', l.unit_price_cents,
                       'lineTotalCents', l.line_total_cents) ORDER BY l.position)
                     FROM offer_lines l WHERE l.customer_id = o.customer_id AND l.offer_id = o.id), '[]'::jsonb) AS lines
    FROM offers o`;

  function toOffer(row: QueryResultRow): Offer {
    const offer = camel<Offer>(row);
    // bigint and numeric columns arrive as text
    return {
      ...offer,
      vatRate: Number(offer.vatRate),
      discountPercent: Number(offer.discountPercent),
      netCents: Number(offer.netCents),
      discountCents: Number(offer.discountCents),
      vatCents: Number(offer.vatCents),
      grossCents: Number(offer.grossCents),
      lines: (row.lines as Offer["lines"]).map((l) => ({
        ...l,
        quantity: Number(l.quantity),
        unitPriceCents: Number(l.unitPriceCents),
        lineTotalCents: Number(l.lineTotalCents),
      })),
    };
  }

  /** Dates as text (YYYY-MM-DD), so no time zone can shift them by a day. */
  const INVOICE_SELECT = `
    SELECT id, customer_id, source, message_id, thread_id, connection_id, file_name, content_hash, status, number,
           language, debtor_domain, debtor_name, amount_cents, currency, issue_date::text AS issue_date,
           due_date::text AS due_date, reminders_made, last_reminder_at, ended_at, ended_by, pending_text, created_at
    FROM invoices`;

  function toInvoice(row: QueryResultRow): Invoice {
    const invoice = camel<Invoice>(row);
    return { ...invoice, amountCents: invoice.amountCents === null ? null : Number(invoice.amountCents) };
  }

  /** All items of a list in one statement; the list travels as JSON so prices stay whole numbers. */
  async function insertPriceItems(priceListId: string, items: NewPriceItem[]) {
    if (items.length === 0) return;
    await run(
      `INSERT INTO price_items (customer_id, price_list_id, position, code, name, unit, net_price_cents, aliases)
       SELECT $1, $2, x.position, x.code, x.name, x.unit, x."netPriceCents", x.aliases
       FROM jsonb_to_recordset($3::jsonb)
         AS x(position integer, code text, name text, unit text, "netPriceCents" bigint, aliases text[])`,
      [priceListId, JSON.stringify(items)],
    );
  }

  return {
    customerId,

    // ---- customer and settings -------------------------------------------------

    async getCustomer(): Promise<Customer> {
      const { rows } = await run("SELECT * FROM customers WHERE id = $1");
      if (!rows[0]) throw new Error("Customer not found");
      const customer = camel<Customer>(rows[0]);
      // numeric columns arrive as text
      return { ...customer, vatRate: Number(customer.vatRate) };
    },

    // ---- offer settings (phase 3) ----------------------------------------------

    async updateOfferSettings(s: OfferSettings) {
      await run(
        `UPDATE customers SET offer_language = $2, offer_layout = $3, currency = $4, vat_rate = $5,
                payment_terms = $6, offer_valid_days = $7, offer_number_pattern = $8, company_details = $9,
                bank_details = $10, offer_footer = $11, brand_color = $12
         WHERE id = $1`,
        [
          s.offerLanguage,
          s.offerLayout,
          s.currency,
          s.vatRate,
          s.paymentTerms,
          s.offerValidDays,
          s.offerNumberPattern,
          s.companyDetails,
          s.bankDetails,
          s.offerFooter,
          s.brandColor,
        ],
      );
    },

    async setLogo(content: Uint8Array, contentType: string) {
      await run(
        `INSERT INTO customer_logos (customer_id, content, content_type) VALUES ($1, $2, $3)
         ON CONFLICT (customer_id) DO UPDATE
           SET content = EXCLUDED.content, content_type = EXCLUDED.content_type, updated_at = now()`,
        [Buffer.from(content), contentType],
      );
    },

    async removeLogo() {
      await run("DELETE FROM customer_logos WHERE customer_id = $1");
    },

    async getLogo(): Promise<{ content: Uint8Array; contentType: string } | null> {
      const { rows } = await run<{ content: Buffer; content_type: string }>(
        "SELECT content, content_type FROM customer_logos WHERE customer_id = $1",
      );
      return rows[0] ? { content: new Uint8Array(rows[0].content), contentType: rows[0].content_type } : null;
    },

    // ---- price lists -----------------------------------------------------------

    /**
     * Stores an uploaded price list as a draft: the sheet as read, the proposed
     * column mapping and the items that mapping gives. Nothing uses it until the
     * customer confirms (activatePriceList). An earlier unconfirmed draft is dropped.
     */
    async createPriceListDraft(d: {
      fileName: string;
      currency: string;
      mapping: PriceListMapping | null;
      raw: PriceListRaw;
      items: NewPriceItem[];
      skipped: { row: number; reason: string }[];
    }): Promise<string> {
      await run("DELETE FROM price_lists WHERE customer_id = $1 AND status = 'draft'");
      const { rows } = await run<{ id: string }>(
        `INSERT INTO price_lists (customer_id, file_name, currency, mapping, raw, item_count, skipped)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [
          d.fileName,
          d.currency,
          JSON.stringify(d.mapping ?? {}),
          JSON.stringify(d.raw),
          d.items.length,
          JSON.stringify(d.skipped),
        ],
      );
      const id = rows[0]!.id;
      await insertPriceItems(id, d.items);
      return id;
    },

    /** The customer chose other columns for a draft: replace its items with what the new mapping gives. */
    async remapPriceListDraft(
      id: string,
      d: { mapping: PriceListMapping; items: NewPriceItem[]; skipped: { row: number; reason: string }[] },
    ): Promise<boolean> {
      const { rowCount } = await run(
        `UPDATE price_lists SET mapping = $3, item_count = $4, skipped = $5
         WHERE customer_id = $1 AND id = $2 AND status = 'draft'`,
        [id, JSON.stringify(d.mapping), d.items.length, JSON.stringify(d.skipped)],
      );
      if (rowCount !== 1) return false;
      await run("DELETE FROM price_items WHERE customer_id = $1 AND price_list_id = $2", [id]);
      await insertPriceItems(id, d.items);
      return true;
    },

    /**
     * The customer confirmed the preview: the draft becomes the active list and
     * the previous one is kept as "replaced" (old offers still point to it).
     * The sheet as read is no longer needed and is removed.
     */
    async activatePriceList(id: string): Promise<boolean> {
      const { rowCount } = await run(
        `WITH previous AS (
           UPDATE price_lists SET status = 'replaced'
           WHERE customer_id = $1 AND status = 'active' AND id <> $2
             AND EXISTS (SELECT 1 FROM price_lists
                         WHERE customer_id = $1 AND id = $2 AND status = 'draft' AND item_count > 0)
           RETURNING id
         )
         UPDATE price_lists SET status = 'active', raw = NULL, activated_at = now()
         WHERE customer_id = $1 AND id = $2 AND status = 'draft' AND item_count > 0
           AND (SELECT count(*) FROM previous) >= 0`,
        [id],
      );
      return rowCount === 1;
    },

    async discardPriceListDraft() {
      await run("DELETE FROM price_lists WHERE customer_id = $1 AND status = 'draft'");
    },

    async getPriceListByStatus(status: "draft" | "active"): Promise<PriceList | null> {
      const { rows } = await run(
        "SELECT * FROM price_lists WHERE customer_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT 1",
        [status],
      );
      return rows[0] ? toPriceList(rows[0]) : null;
    },

    async listPriceItems(priceListId: string, limit = 10_000): Promise<PriceListItem[]> {
      const { rows } = await run(
        `SELECT id, price_list_id, position, code, name, unit, net_price_cents, aliases FROM price_items
         WHERE customer_id = $1 AND price_list_id = $2 ORDER BY position LIMIT $3`,
        [priceListId, limit],
      );
      return rows.map((r) => {
        const item = camel<PriceListItem>(r);
        return { ...item, netPriceCents: Number(item.netPriceCents) };
      });
    },

    // ---- offers and order confirmations ----------------------------------------

    /**
     * Takes the next offer number for a year. The counter restarts each year and
     * two offers can never get the same number, even when made at the same moment.
     */
    async nextOfferCounter(year: number): Promise<{ counter: number; pattern: string }> {
      const { rows } = await run<{ offer_counter: number; offer_number_pattern: string }>(
        `UPDATE customers
         SET offer_counter = CASE WHEN offer_counter_year = $2 THEN offer_counter + 1 ELSE 1 END,
             offer_counter_year = $2
         WHERE id = $1
         RETURNING offer_counter, offer_number_pattern`,
        [year],
      );
      return { counter: rows[0]!.offer_counter, pattern: rows[0]!.offer_number_pattern };
    },

    /**
     * Stores an offer with its lines in one step. Returns null when a document of
     * this kind already exists for the same message: one offer per request, ever.
     */
    async createOffer(o: NewOffer): Promise<string | null> {
      const { rows } = await run<{ offer_id: string }>(
        `WITH created AS (
           INSERT INTO offers
             (customer_id, kind, number, thread_id, message_id, source_offer_id, price_list_id, recipient_domain,
              language, layout, currency, vat_rate, discount_percent, net_cents, discount_cents, vat_cents,
              gross_cents, valid_until, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::date,
                   COALESCE($19::timestamptz, now()))
           ON CONFLICT (customer_id, kind, message_id) DO NOTHING
           RETURNING id
         )
         INSERT INTO offer_lines
           (customer_id, offer_id, position, code, name, unit, quantity, unit_price_cents, line_total_cents)
         SELECT $1, created.id, x.position, x.code, x.name, x.unit, x.quantity, x."unitPriceCents", x."lineTotalCents"
         FROM created, jsonb_to_recordset($20::jsonb)
           AS x(position integer, code text, name text, unit text, quantity numeric,
                "unitPriceCents" bigint, "lineTotalCents" bigint)
         RETURNING offer_id`,
        [
          o.kind,
          o.number,
          o.threadId,
          o.messageId,
          o.sourceOfferId,
          o.priceListId,
          o.recipientDomain,
          o.language,
          o.layout,
          o.currency,
          o.vatRate,
          o.discountPercent,
          o.netCents,
          o.discountCents,
          o.vatCents,
          o.grossCents,
          o.validUntil,
          o.createdAt ?? null,
          JSON.stringify(o.lines),
        ],
      );
      return rows[0]?.offer_id ?? null;
    },

    async getOffer(id: string): Promise<Offer | null> {
      const { rows } = await run(`${OFFER_SELECT} WHERE o.customer_id = $1 AND o.id = $2`, [id]);
      return rows[0] ? toOffer(rows[0]) : null;
    },

    /** The offer (or order confirmation) that was made for a message, if any. */
    async getOfferForMessage(kind: OfferKind, messageId: string): Promise<Offer | null> {
      const { rows } = await run(`${OFFER_SELECT} WHERE o.customer_id = $1 AND o.kind = $2 AND o.message_id = $3`, [
        kind,
        messageId,
      ]);
      return rows[0] ? toOffer(rows[0]) : null;
    },

    /** The most recent offer in a conversation that has not been accepted yet. */
    async latestOpenOfferForThread(threadId: string): Promise<Offer | null> {
      const { rows } = await run(
        `${OFFER_SELECT} WHERE o.customer_id = $1 AND o.thread_id = $2 AND o.kind = 'offer' AND o.status = 'prepared'
         ORDER BY o.created_at DESC LIMIT 1`,
        [threadId],
      );
      return rows[0] ? toOffer(rows[0]) : null;
    },

    async markOfferAccepted(id: string) {
      await run("UPDATE offers SET status = 'accepted' WHERE customer_id = $1 AND id = $2", [id]);
    },

    async setOfferStoredPath(id: string, storedPath: string) {
      await run("UPDATE offers SET stored_path = $3 WHERE customer_id = $1 AND id = $2", [id, storedPath]);
    },

    /** Offers and order confirmations made in [from, to), for the daily brief. */
    async listOffersBetween(from: Date, to: Date): Promise<Offer[]> {
      const { rows } = await run(
        `${OFFER_SELECT} WHERE o.customer_id = $1 AND o.created_at >= $2 AND o.created_at < $3 ORDER BY o.created_at`,
        [from, to],
      );
      return rows.map(toOffer);
    },

    // ---- invoices and payment reminders (phase 4) -------------------------------

    async claimRemindForDate(localDate: string): Promise<boolean> {
      const { rowCount } = await run(
        `UPDATE customers SET remind_last_run_on = $2::date
         WHERE id = $1 AND (remind_last_run_on IS NULL OR remind_last_run_on < $2::date)`,
        [localDate],
      );
      return rowCount === 1;
    },

    async releaseRemindForDate(localDate: string) {
      await run(
        `UPDATE customers SET remind_last_run_on = $2::date - 1
         WHERE id = $1 AND remind_last_run_on = $2::date`,
        [localDate],
      );
    },

    /**
     * Notes a PDF that may be one of the customer's invoices, to be read next.
     * Returns null when the same file (same content) is already known.
     */
    async createInvoice(i: {
      source: "sent" | "forwarded";
      messageId: string | null;
      threadId: string | null;
      connectionId: string | null;
      fileName: string;
      contentHash: string;
      debtorDomain?: string;
      status?: "pending" | "unreadable";
      pendingText?: string | null;
    }): Promise<string | null> {
      const { rows } = await run<{ id: string }>(
        `INSERT INTO invoices
           (customer_id, source, message_id, thread_id, connection_id, file_name, content_hash, debtor_domain,
            status, pending_text)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (customer_id, content_hash) DO NOTHING
         RETURNING id`,
        [
          i.source,
          i.messageId,
          i.threadId,
          i.connectionId,
          i.fileName.slice(0, 200),
          i.contentHash,
          i.debtorDomain ?? "",
          i.status ?? "pending",
          i.pendingText ?? null,
        ],
      );
      return rows[0]?.id ?? null;
    },

    async getInvoice(id: string): Promise<Invoice | null> {
      const { rows } = await run(`${INVOICE_SELECT} WHERE customer_id = $1 AND id = $2`, [id]);
      return rows[0] ? toInvoice(rows[0]) : null;
    },

    /** Another tracked invoice with this number, if there is one (the same invoice sent again as a different file). */
    async findInvoiceByNumber(number: string, exceptId: string): Promise<Invoice | null> {
      const { rows } = await run(
        `${INVOICE_SELECT} WHERE customer_id = $1 AND lower(number) = lower($2) AND id <> $3
           AND status IN ('open', 'needs_due_date', 'paid', 'stopped')
         LIMIT 1`,
        [number, exceptId],
      );
      return rows[0] ? toInvoice(rows[0]) : null;
    },

    /** The result of reading an invoice. The text that was read is removed in the same step. */
    async setInvoiceRead(
      id: string,
      r: {
        status: InvoiceStatus;
        number?: string | null;
        language?: string | null;
        debtorName?: string;
        amountCents?: number | null;
        currency?: string | null;
        issueDate?: string | null;
        dueDate?: string | null;
      },
    ) {
      await run(
        `UPDATE invoices SET status = $3, number = $4, language = $5, debtor_name = $6, amount_cents = $7,
                currency = $8, issue_date = $9::date, due_date = $10::date, pending_text = NULL
         WHERE customer_id = $1 AND id = $2`,
        [
          id,
          r.status,
          r.number ?? null,
          r.language ?? null,
          r.debtorName ?? "",
          r.amountCents ?? null,
          r.currency ?? null,
          r.issueDate ?? null,
          r.dueDate ?? null,
        ],
      );
    },

    /** Invoices being chased: read, with a due date, not paid. */
    async listOpenInvoices(): Promise<Invoice[]> {
      const { rows } = await run(
        `${INVOICE_SELECT} WHERE customer_id = $1 AND status = 'open' AND due_date IS NOT NULL ORDER BY due_date`,
      );
      return rows.map(toInvoice);
    },

    async listOpenInvoicesForThread(threadId: string): Promise<Invoice[]> {
      const { rows } = await run(`${INVOICE_SELECT} WHERE customer_id = $1 AND thread_id = $2 AND status = 'open'`, [
        threadId,
      ]);
      return rows.map(toInvoice);
    },

    async recordReminder(id: string, at: Date) {
      await run(
        `UPDATE invoices SET reminders_made = reminders_made + 1, last_reminder_at = $3
         WHERE customer_id = $1 AND id = $2`,
        [id, at],
      );
    },

    /** Ends the reminder chain: paid (said by the sender, or by the owner's click) or stopped by the owner. */
    async endInvoice(id: string, status: "paid" | "stopped", by: "owner" | "sender", at: Date): Promise<boolean> {
      const { rowCount } = await run(
        `UPDATE invoices SET status = $3, ended_by = $4, ended_at = $5
         WHERE customer_id = $1 AND id = $2 AND status IN ('open', 'needs_due_date')`,
        [id, status, by, at],
      );
      return rowCount === 1;
    },

    /** The owner supplied the due date that could not be read from the invoice. */
    async setInvoiceDueDate(id: string, dueDate: string): Promise<boolean> {
      const { rowCount } = await run(
        `UPDATE invoices SET due_date = $3::date, status = 'open'
         WHERE customer_id = $1 AND id = $2 AND status IN ('needs_due_date', 'open')`,
        [id, dueDate],
      );
      return rowCount === 1;
    },

    /**
     * What the "overdue money" section of the brief shows for one morning:
     *   reminded: invoices that got a reminder draft since `since` (this morning's scan),
     *   paidBySender: invoices a sender said they paid in [yesterday, since), for the owner to verify,
     *   toAsk: invoices without a readable due date, or unreadable ones, not mentioned before.
     * The "toAsk" invoices are marked as mentioned, so each is asked about once.
     */
    async invoicesForBrief(since: Date, yesterday: Date, localDate: string) {
      const reminded = await run(`${INVOICE_SELECT} WHERE customer_id = $1 AND last_reminder_at >= $2 ORDER BY due_date`, [
        since,
      ]);
      const paid = await run(
        `${INVOICE_SELECT} WHERE customer_id = $1 AND status = 'paid' AND ended_by = 'sender'
           AND ended_at >= $2 AND ended_at < $3 ORDER BY ended_at`,
        [yesterday, since],
      );
      const toAsk = await run(
        `WITH marked AS (
           UPDATE invoices SET listed_on = $2::date
           WHERE customer_id = $1 AND status IN ('needs_due_date', 'unreadable') AND listed_on IS NULL
           RETURNING id
         )
         ${INVOICE_SELECT} WHERE customer_id = $1 AND id IN (SELECT id FROM marked) ORDER BY created_at`,
        [localDate],
      );
      return { reminded: reminded.rows.map(toInvoice), paidBySender: paid.rows.map(toInvoice), toAsk: toAsk.rows.map(toInvoice) };
    },

    /** The reminder draft still waiting for an invoice's mail, if any. */
    async getOpenReminder(messageId: string): Promise<Draft | null> {
      const { rows } = await run(
        `SELECT * FROM drafts
         WHERE customer_id = $1 AND message_id = $2 AND kind = 'reminder' AND status = 'created'
         ORDER BY completed_at DESC LIMIT 1`,
        [messageId],
      );
      return rows[0] ? camel<Draft>(rows[0]) : null;
    },

    // ---- discounts per sender --------------------------------------------------

    async listDiscounts(): Promise<SenderDiscount[]> {
      const { rows } = await run("SELECT id, match, percent FROM sender_discounts WHERE customer_id = $1 ORDER BY match");
      return rows.map((r) => ({ id: r.id as string, match: r.match as string, percent: Number(r.percent) }));
    },

    async setDiscount(match: string, percent: number) {
      await run(
        `INSERT INTO sender_discounts (customer_id, match, percent) VALUES ($1, $2, $3)
         ON CONFLICT (customer_id, match) DO UPDATE SET percent = EXCLUDED.percent`,
        [match.trim().toLowerCase(), percent],
      );
    },

    async deleteDiscount(id: string) {
      await run("DELETE FROM sender_discounts WHERE customer_id = $1 AND id = $2", [id]);
    },

    /** The discount for a sender: a rule for their exact address wins over one for their domain. 0 = none. */
    async discountFor(address: string | null, domain: string): Promise<number> {
      const { rows } = await run<{ percent: string }>(
        `SELECT percent FROM sender_discounts
         WHERE customer_id = $1 AND match IN ($2, $3)
         ORDER BY (match = $2) DESC LIMIT 1`,
        [(address ?? "").toLowerCase(), domain.toLowerCase()],
      );
      return rows[0] ? Number(rows[0].percent) : 0;
    },

    async updateSettings(s: {
      name: string;
      languages: string[];
      timeZone: string;
      signatureText: string;
      /** Omitted = leave as it is. */
      followUpDays?: number;
      replyDrafts?: ReplyDraftMode;
    }) {
      await run(
        `UPDATE customers SET name = $2, languages = $3, time_zone = $4, signature_text = $5,
                follow_up_days = COALESCE($6, follow_up_days), reply_drafts = COALESCE($7, reply_drafts)
         WHERE id = $1`,
        [s.name, s.languages, s.timeZone, s.signatureText, s.followUpDays ?? null, s.replyDrafts ?? null],
      );
    },

    /** Billing details with the outcome of the VAT number check that was just made. */
    async updateBilling(b: {
      billingName: string;
      billingAddress: string;
      billingCountry: string;
      vatNumber: string;
      vatStatus: Customer["vatStatus"];
      vatCheckedAt: Date | null;
      vatRegisteredName: string | null;
    }) {
      await run(
        `UPDATE customers SET billing_name = $2, billing_address = $3, billing_country = $4, vat_number = $5,
                vat_status = $6, vat_checked_at = $7, vat_registered_name = $8
         WHERE id = $1`,
        [b.billingName, b.billingAddress, b.billingCountry, b.vatNumber, b.vatStatus, b.vatCheckedAt, b.vatRegisteredName],
      );
    },

    /**
     * Everything stored for this customer, for "download my data": one list of rows per table.
     * Left out on purpose: sign-in tokens and sessions, the keys to the mailbox, bookmarks into
     * the mailbox, any email or document text still waiting to be deleted, and file contents.
     */
    async exportData(): Promise<Record<string, Record<string, unknown>[]>> {
      const SECRET = new Set([
        "access_token_enc", "refresh_token_enc", "delta_link", "sent_delta_link", "subscription_id",
        "body_text", "pending_text", "raw", "content",
      ]);
      const strip = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([key]) => !SECRET.has(key)));
      const out: Record<string, Record<string, unknown>[]> = {};
      out.customer = (await run("SELECT * FROM customers WHERE id = $1")).rows.map(strip);
      // Fixed names, never taken from input.
      const tables = [
        "users", "mailbox_connections", "threads", "messages", "drafts", "filed_documents", "customer_logos",
        "price_lists", "price_items", "sender_discounts", "offers", "offer_lines", "invoices", "job_runs", "audit_events",
      ];
      for (const table of tables) {
        out[table] = (await run(`SELECT * FROM ${table} WHERE customer_id = $1`)).rows.map(strip);
      }
      return out;
    },

    /** Remembers which Stripe customer this account is, once, the first time a plan is chosen. */
    async setStripeCustomerId(stripeCustomerId: string) {
      await run("UPDATE customers SET stripe_customer_id = $2 WHERE id = $1 AND stripe_customer_id IS NULL", [stripeCustomerId]);
    },

    /** The owner finished or skipped the "Getting started" guide. */
    async finishSetup() {
      await run("UPDATE customers SET setup_finished_at = COALESCE(setup_finished_at, now()) WHERE id = $1");
    },

    /**
     * Notes that the guide's test mail is being sent now. False when one was sent less than
     * two minutes ago: a double click must not send two.
     */
    async claimSetupTestMail(now: Date): Promise<boolean> {
      const { rowCount } = await run(
        `UPDATE customers SET setup_test_sent_at = $2
         WHERE id = $1 AND (setup_test_sent_at IS NULL OR setup_test_sent_at < $2::timestamptz - interval '2 minutes')`,
        [now],
      );
      return (rowCount ?? 0) > 0;
    },

    /** Stores what was read from a sample document until the owner decides; null clears it. */
    async setOfferProposal(proposal: OfferProposal | null) {
      await run("UPDATE customers SET offer_proposal = $2 WHERE id = $1", [proposal ? JSON.stringify(proposal) : null]);
    },

    /** Gives back a draft slot that was reserved but will not be used (the mail turned out to need no draft). */
    async releaseDraftClaim(id: string) {
      await run("DELETE FROM drafts WHERE customer_id = $1 AND id = $2 AND status = 'pending'", [id]);
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

    async setClassification(messageId: string, classification: Classification, language: string | null, suspicious = false) {
      await run(
        "UPDATE messages SET classification = $3, language = $4, suspicious = $5 WHERE customer_id = $1 AND id = $2",
        [messageId, classification, language, suspicious],
      );
    },

    /** Business mail received in the period that tried to instruct an automated assistant. */
    async listSuspiciousBetween(from: Date, to: Date): Promise<{ subject: string; senderDomain: string }[]> {
      const { rows } = await run(
        `SELECT subject, sender_domain FROM messages
         WHERE customer_id = $1 AND direction = 'inbound' AND suspicious AND received_at >= $2 AND received_at < $3
         ORDER BY received_at`,
        [from, to],
      );
      return rows.map((r) => camel<{ subject: string; senderDomain: string }>(r));
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

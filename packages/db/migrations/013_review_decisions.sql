-- Decisions on the independent review (Ramon, 2026-11-24).

-- The forwarding address only takes mail from addresses the customer listed.
-- Sign-in addresses are always accepted and are not stored here.
CREATE TABLE accepted_senders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  address     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, address)
);

-- needs_confirm = read, but sent to someone who does not look like the buyer: the owner is asked once.
ALTER TABLE invoices DROP CONSTRAINT invoices_status_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_status_check
  CHECK (status IN ('pending', 'open', 'needs_due_date', 'needs_confirm', 'unreadable', 'not_ours', 'duplicate', 'paid', 'stopped'));

-- The customer-local date on which the next reminder was due but the previous one still sat unsent in Drafts.
ALTER TABLE invoices ADD COLUMN reminder_blocked_on date;

-- Follow-up drafts that were written but skipped or deleted unsent. They do not count toward the
-- two follow-ups per silence (chaser_count keeps counting every draft written, so drafts keep
-- their own number).
ALTER TABLE threads ADD COLUMN chasers_unused integer NOT NULL DEFAULT 0;

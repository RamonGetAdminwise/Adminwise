-- Phase 4, part 1: invoices the customer sent to their own customers, and payment reminders.
-- Kept per invoice: number, amount, dates, who it went to. The PDF and its text are not kept.

ALTER TABLE customers ADD COLUMN remind_last_run_on date;   -- customer-local date of the last reminder scan

-- A reminder is a fourth kind of draft; its seq is the reminder level (1, 2, 3).
ALTER TABLE drafts DROP CONSTRAINT drafts_kind_check;
ALTER TABLE drafts ADD CONSTRAINT drafts_kind_check
  CHECK (kind IN ('reply', 'chaser', 'order_confirmation', 'reminder'));

CREATE TABLE invoices (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id      uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  source           text NOT NULL CHECK (source IN ('sent', 'forwarded')),  -- seen in Sent Items, or forwarded to us by the customer
  message_id       uuid REFERENCES messages(id) ON DELETE SET NULL,        -- the mail that carried it
  thread_id        uuid REFERENCES threads(id) ON DELETE SET NULL,
  connection_id    uuid REFERENCES mailbox_connections(id) ON DELETE SET NULL,
  file_name        text NOT NULL DEFAULT '',
  content_hash     text NOT NULL,                 -- sha256 of the PDF: the same file is tracked once
  -- pending = waiting to be read; open = tracked, reminders will follow;
  -- needs_due_date = the owner is asked for the due date; unreadable = could not be read, not tracked;
  -- not_ours = not an invoice issued by the customer; paid / stopped = the chain has ended.
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'open', 'needs_due_date', 'unreadable', 'not_ours', 'paid', 'stopped')),
  number           text,
  debtor_domain    text NOT NULL DEFAULT '',
  debtor_name      text NOT NULL DEFAULT '',
  amount_cents     bigint,
  currency         text,
  issue_date       date,
  due_date         date,
  reminders_made   integer NOT NULL DEFAULT 0,
  last_reminder_at timestamptz,
  ended_at         timestamptz,
  ended_by         text CHECK (ended_by IN ('owner', 'sender')),
  listed_on        date,                          -- customer-local date it was mentioned in the brief (asked once)
  pending_text     text,                          -- text read from a forwarded PDF, until the job has read it; purged like email bodies
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, content_hash)
);
CREATE INDEX invoices_open_idx ON invoices(customer_id, due_date) WHERE status = 'open';
CREATE INDEX invoices_thread_idx ON invoices(customer_id, thread_id);
CREATE INDEX invoices_pending_text_idx ON invoices(created_at) WHERE pending_text IS NOT NULL;

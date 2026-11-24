-- Fixes from the independent review of 2026-11-24.

-- A payment reminder belongs to an invoice, not to the mail that carried it:
-- two invoices sent in one mail each get their own reminders.
ALTER TABLE drafts ADD COLUMN invoice_id uuid REFERENCES invoices(id) ON DELETE CASCADE;
UPDATE drafts d SET invoice_id = (
  SELECT i.id FROM invoices i
  WHERE i.customer_id = d.customer_id AND i.message_id = d.message_id
  ORDER BY i.created_at LIMIT 1
) WHERE d.kind = 'reminder';
DELETE FROM drafts WHERE kind = 'reminder' AND invoice_id IS NULL;

ALTER TABLE drafts DROP CONSTRAINT drafts_one_per_message;
CREATE UNIQUE INDEX drafts_one_per_message ON drafts(customer_id, message_id, kind, seq) WHERE kind <> 'reminder';
CREATE UNIQUE INDEX drafts_one_per_invoice ON drafts(customer_id, invoice_id, seq) WHERE kind = 'reminder';

-- Finding the runs of one message or one day quickly (re-driving unhandled mail, daily retries).
CREATE INDEX job_runs_ref_idx ON job_runs(customer_id, job, ref);

-- Sign-in links: who asked, to limit how many can be requested.
CREATE INDEX login_tokens_email_idx ON login_tokens(email, created_at);

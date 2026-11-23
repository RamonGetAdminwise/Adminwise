-- Phase 2: follow-up chaser, filing to OneDrive, full daily brief.

-- ---- settings ---------------------------------------------------------------
ALTER TABLE customers
  ADD COLUMN follow_up_days    integer NOT NULL DEFAULT 5 CHECK (follow_up_days BETWEEN 1 AND 30), -- working days
  ADD COLUMN chase_last_run_on date;   -- customer-local date of the last nightly chaser scan

-- ---- mailbox connection -----------------------------------------------------
ALTER TABLE mailbox_connections
  ADD COLUMN scopes          text NOT NULL DEFAULT '',  -- what Microsoft granted, space-separated
  ADD COLUMN sent_delta_link text,                      -- where polling of Sent Items resumes
  ADD COLUMN drive_error     text,                      -- short reason OneDrive could not be reached; null = fine
  ADD COLUMN drive_error_at  timestamptz;

-- ---- threads: who wrote last, and the chaser state ----------------------------
ALTER TABLE threads
  ADD COLUMN last_inbound_at   timestamptz,   -- last mail from the other party (automatic replies do not count)
  ADD COLUMN last_outbound_at  timestamptz,   -- last mail the customer sent
  ADD COLUMN chase_mode        text NOT NULL DEFAULT 'on'
                               CHECK (chase_mode IN ('on', 'never', 'done')),  -- never = customer said so; done = 2 chasers used
  ADD COLUMN chase_hold_from   timestamptz,   -- the follow-up period counts from here ("not this time", last chaser)
  ADD COLUMN chaser_count      integer NOT NULL DEFAULT 0,  -- chasers written since the other party last replied
  ADD COLUMN expects_reply     boolean,       -- does the customer's last message expect an answer?
  ADD COLUMN expects_reply_for uuid,          -- the message that judgement is about
  ADD COLUMN went_quiet_on     date;          -- customer-local date it was listed as "went quiet" without a chaser

UPDATE threads t SET last_inbound_at = m.last
FROM (SELECT thread_id, max(received_at) AS last FROM messages WHERE direction = 'inbound' GROUP BY thread_id) m
WHERE m.thread_id = t.id;
UPDATE threads t SET last_outbound_at = m.last
FROM (SELECT thread_id, max(received_at) AS last FROM messages WHERE direction = 'outbound' GROUP BY thread_id) m
WHERE m.thread_id = t.id;

CREATE INDEX threads_chase_idx ON threads(customer_id, last_outbound_at) WHERE chase_mode = 'on';

-- ---- drafts: chasers next to replies -----------------------------------------
-- A reply is still one per inbound message. A chaser hangs on the customer's own
-- last message and may be written a second time, so the key gets a sequence number.
ALTER TABLE drafts ADD COLUMN seq smallint NOT NULL DEFAULT 1;
ALTER TABLE drafts DROP CONSTRAINT drafts_customer_id_message_id_kind_key;
ALTER TABLE drafts ADD CONSTRAINT drafts_one_per_message UNIQUE (customer_id, message_id, kind, seq);
ALTER TABLE drafts ADD CONSTRAINT drafts_kind_check CHECK (kind IN ('reply', 'chaser'));
ALTER TABLE drafts DROP CONSTRAINT drafts_status_check;
-- closed = a chaser that is no longer waiting: sent, deleted, skipped, or overtaken by a new message
ALTER TABLE drafts ADD CONSTRAINT drafts_status_check CHECK (status IN ('pending', 'created', 'failed', 'closed'));
CREATE INDEX drafts_open_chasers_idx ON drafts(customer_id, thread_id) WHERE kind = 'chaser' AND status = 'created';

-- ---- filing --------------------------------------------------------------------
-- Metadata and the content hash only. The file itself goes to the customer's
-- OneDrive and is never stored here.
CREATE TABLE filed_documents (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id         uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  message_id          uuid REFERENCES messages(id) ON DELETE SET NULL,
  connection_id       uuid REFERENCES mailbox_connections(id) ON DELETE SET NULL,
  provider_message_id text NOT NULL,
  attachment_id       text NOT NULL,
  original_name       text NOT NULL,
  size_bytes          integer NOT NULL DEFAULT 0,
  content_hash        text,                 -- sha256 of the file; null until it has been read
  doc_type            text CHECK (doc_type IN ('invoice', 'order', 'contract', 'offer', 'other')),
  sender_folder       text NOT NULL DEFAULT '',
  status              text NOT NULL CHECK (status IN ('filed', 'duplicate', 'queued', 'failed')),
  stored_path         text,                 -- path inside the app folder, e.g. rolmet.example/2026-11/2026-11-20_invoice_FV.pdf
  drive_item_id       text,
  duplicate_of        uuid REFERENCES filed_documents(id) ON DELETE SET NULL,
  error               text,                 -- short technical reason, never file content
  attempts            integer NOT NULL DEFAULT 0,
  last_attempt_at     timestamptz,
  received_at         timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  filed_at            timestamptz,
  UNIQUE (customer_id, provider_message_id, attachment_id)
);
CREATE UNIQUE INDEX filed_documents_hash_idx ON filed_documents(customer_id, content_hash) WHERE status = 'filed';
CREATE INDEX filed_documents_filed_idx ON filed_documents(customer_id, filed_at);
CREATE INDEX filed_documents_queued_idx ON filed_documents(customer_id, connection_id) WHERE status = 'queued';

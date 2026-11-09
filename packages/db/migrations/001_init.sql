-- First cut of the data model (phase 1).
-- Rule: every table that holds customer data has customer_id, and is only
-- reached through the scoped data layer in packages/db/src/scoped.ts.

CREATE TABLE customers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL DEFAULT '',
  slug               text NOT NULL UNIQUE,            -- forwarding address: <slug>@in.<domain>
  languages          text[] NOT NULL DEFAULT '{en}',  -- ISO 639-1 codes the customer works in
  time_zone          text NOT NULL DEFAULT 'Europe/Warsaw', -- IANA name
  signature_text     text NOT NULL DEFAULT '',
  voice_profile      text NOT NULL DEFAULT '',
  brief_last_sent_on date,                            -- customer-local date of the last daily brief
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  email       text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX users_customer_idx ON users(customer_id);

-- Sign-in plumbing. Tokens are stored hashed; a leaked database row cannot be used to sign in.
CREATE TABLE login_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email      text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mailbox_connections (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id             uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  provider                text NOT NULL CHECK (provider IN ('microsoft', 'forwarding')),
  email_address           text NOT NULL DEFAULT '',
  status                  text NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'needs_reconnect', 'revoked', 'disconnected')),
  access_token_enc        text,          -- AES-256-GCM, see crypto.ts
  refresh_token_enc       text,          -- AES-256-GCM, see crypto.ts
  token_expires_at        timestamptz,
  subscription_id         text,          -- Graph change-notification subscription
  subscription_expires_at timestamptz,
  client_state            text,          -- secret echoed by Graph in each notification
  delta_link              text,          -- where the 5-minute polling fallback resumes
  last_sync_at            timestamptz,
  last_error              text,          -- short technical reason, never email content
  created_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, provider)
);
CREATE INDEX mailbox_connections_subscription_idx ON mailbox_connections(subscription_id);

CREATE TABLE threads (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id        uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  provider_thread_id text NOT NULL,
  subject            text NOT NULL DEFAULT '',
  last_message_at    timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, provider_thread_id)
);

-- Metadata stays; body_text and from_address are emptied by the purge job within 24 h.
CREATE TABLE messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id         uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  thread_id           uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  connection_id       uuid REFERENCES mailbox_connections(id) ON DELETE SET NULL,
  dedupe_key          text NOT NULL,   -- Internet Message-ID, or the provider id if missing
  provider_message_id text NOT NULL,
  direction           text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  sender_domain       text NOT NULL DEFAULT '',
  from_address        text,            -- purged with the body
  subject             text NOT NULL DEFAULT '',
  received_at         timestamptz NOT NULL,
  header_flags        jsonb NOT NULL DEFAULT '{}',  -- booleans only: auto-submitted, bulk, list
  attachment_names    text[] NOT NULL DEFAULT '{}',
  classification      text CHECK (classification IN
                        ('business', 'newsletter', 'notification', 'auto_reply', 'internal')),
  language            text,            -- ISO 639-1 code of the sender's language
  body_text           text,            -- purged
  body_purged_at      timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, dedupe_key)
);
CREATE INDEX messages_thread_idx ON messages(customer_id, thread_id, received_at);
CREATE INDEX messages_purge_idx ON messages(created_at) WHERE body_purged_at IS NULL;

CREATE TABLE drafts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id       uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  message_id        uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  thread_id         uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  kind              text NOT NULL DEFAULT 'reply',
  destination       text NOT NULL CHECK (destination IN ('outlook_drafts', 'email_to_customer')),
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'created', 'failed')),
  language          text,
  language_listed   boolean NOT NULL DEFAULT true,  -- false = sender wrote in a language the customer did not list
  provider_draft_id text,
  body_text         text,              -- what we generated; purged with the message bodies
  body_purged_at    timestamptz,
  error             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz,
  UNIQUE (customer_id, message_id, kind)   -- one reply draft per inbound message, ever
);
CREATE INDEX drafts_customer_created_idx ON drafts(customer_id, created_at);

-- The product Control Tower: every job run, one row.
CREATE TABLE job_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   uuid REFERENCES customers(id) ON DELETE CASCADE,  -- null for system-wide jobs
  job           text NOT NULL,
  status        text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed', 'skipped')),
  ref           text,                  -- id of the thing worked on (message id, connection id)
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  input_tokens  integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  error         text
);
CREATE INDEX job_runs_customer_started_idx ON job_runs(customer_id, started_at DESC);

CREATE TABLE audit_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  action      text NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_customer_idx ON audit_events(customer_id, created_at DESC);

-- Phase 3: price lists, offers, order confirmations.
-- Money is stored in the smallest unit (grosz, cent) as whole numbers, so
-- totals are exact. Every number in an offer comes from these tables.

-- ---- offer settings (per customer) ------------------------------------------
ALTER TABLE customers
  ADD COLUMN offer_language       text NOT NULL DEFAULT 'en' CHECK (offer_language IN ('en', 'pl')),  -- language of the offer document's own texts
  ADD COLUMN offer_layout         text NOT NULL DEFAULT 'classic' CHECK (offer_layout IN ('classic', 'modern', 'compact')),
  ADD COLUMN currency             text NOT NULL DEFAULT 'PLN' CHECK (currency ~ '^[A-Z]{3}$'),
  ADD COLUMN vat_rate             numeric(5,2) NOT NULL DEFAULT 23.00 CHECK (vat_rate >= 0 AND vat_rate <= 100),
  ADD COLUMN payment_terms        text NOT NULL DEFAULT '',
  ADD COLUMN offer_valid_days     integer NOT NULL DEFAULT 14 CHECK (offer_valid_days BETWEEN 1 AND 365),
  ADD COLUMN offer_number_pattern text NOT NULL DEFAULT 'OF/{YYYY}/{NNN}',   -- {YYYY} year, {NNN} counter within the year
  ADD COLUMN offer_counter_year   integer,
  ADD COLUMN offer_counter        integer NOT NULL DEFAULT 0,
  ADD COLUMN company_details      text NOT NULL DEFAULT '',   -- address, tax number: printed in the offer header
  ADD COLUMN bank_details         text NOT NULL DEFAULT '',
  ADD COLUMN offer_footer         text NOT NULL DEFAULT '',
  ADD COLUMN brand_color          text NOT NULL DEFAULT '#1f6f6b' CHECK (brand_color ~ '^#[0-9a-fA-F]{6}$');

-- The customer's own logo, shown on their offers. In its own table so that
-- reading a customer's settings does not carry the picture along every time.
CREATE TABLE customer_logos (
  customer_id  uuid PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  content      bytea NOT NULL,
  content_type text NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/svg+xml')),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- ---- price lists --------------------------------------------------------------
-- One active list per customer. An upload starts as "draft" with the sheet as
-- read and a proposed column mapping; the customer confirms a preview, then it
-- becomes "active" and the previous one "replaced". This is the customer's own
-- business data, kept until they replace or delete it (not email content).
CREATE TABLE price_lists (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id  uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  file_name    text NOT NULL DEFAULT '',
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'replaced')),
  currency     text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  mapping      jsonb NOT NULL DEFAULT '{}',   -- which column is code / name / unit / price / aliases, and how it was found
  raw          jsonb,                         -- header and rows as read from the sheet; removed once confirmed
  item_count   integer NOT NULL DEFAULT 0,
  skipped      jsonb NOT NULL DEFAULT '[]',   -- rows that could not be read: [{ row, reason }]
  created_at   timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz
);
CREATE UNIQUE INDEX price_lists_one_active_idx ON price_lists(customer_id) WHERE status = 'active';
CREATE INDEX price_lists_customer_idx ON price_lists(customer_id, created_at DESC);

CREATE TABLE price_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id     uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  price_list_id   uuid NOT NULL REFERENCES price_lists(id) ON DELETE CASCADE,
  position        integer NOT NULL,           -- order in the customer's sheet
  code            text NOT NULL DEFAULT '',
  name            text NOT NULL,
  unit            text NOT NULL DEFAULT '',
  net_price_cents bigint NOT NULL CHECK (net_price_cents >= 0),
  aliases         text[] NOT NULL DEFAULT '{}'
);
CREATE INDEX price_items_list_idx ON price_items(customer_id, price_list_id, position);

-- ---- discounts per sender -----------------------------------------------------
CREATE TABLE sender_discounts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  match       text NOT NULL,                  -- a domain ("rolmet.example") or one address, lower case
  percent     numeric(5,2) NOT NULL CHECK (percent > 0 AND percent <= 100),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, match)
);

-- A third kind of draft: the order confirmation the owner asked for from the brief
-- (it hangs on the original request, next to the reply draft that carried the offer).
ALTER TABLE drafts DROP CONSTRAINT drafts_kind_check;
ALTER TABLE drafts ADD CONSTRAINT drafts_kind_check CHECK (kind IN ('reply', 'chaser', 'order_confirmation'));

-- ---- offers and order confirmations --------------------------------------------
-- An offer keeps its own lines and prices: a later price list never changes an
-- offer that was already made.
CREATE TABLE offers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id      uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('offer', 'order_confirmation')),
  number           text NOT NULL,
  thread_id        uuid REFERENCES threads(id) ON DELETE SET NULL,
  message_id       uuid REFERENCES messages(id) ON DELETE SET NULL,   -- the request (offer) or the acceptance (confirmation)
  source_offer_id  uuid REFERENCES offers(id) ON DELETE SET NULL,     -- the offer an order confirmation was made from
  price_list_id    uuid REFERENCES price_lists(id) ON DELETE SET NULL,
  status           text NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared', 'accepted')),
  recipient_domain text NOT NULL DEFAULT '',
  language         text NOT NULL,
  layout           text NOT NULL,
  currency         text NOT NULL,
  vat_rate         numeric(5,2) NOT NULL,
  discount_percent numeric(5,2) NOT NULL DEFAULT 0,
  net_cents        bigint NOT NULL,           -- sum of the lines
  discount_cents   bigint NOT NULL DEFAULT 0,
  vat_cents        bigint NOT NULL,
  gross_cents      bigint NOT NULL,
  valid_until      date,
  stored_path      text,                      -- where the copy was filed in the app folder, if it was
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, kind, number),
  UNIQUE (customer_id, kind, message_id)      -- one offer per request, ever
);
CREATE INDEX offers_thread_idx ON offers(customer_id, thread_id, created_at);
CREATE INDEX offers_created_idx ON offers(customer_id, created_at);

CREATE TABLE offer_lines (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id      uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  offer_id         uuid NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  position         integer NOT NULL,
  code             text NOT NULL DEFAULT '',
  name             text NOT NULL,
  unit             text NOT NULL DEFAULT '',
  quantity         numeric(12,3) NOT NULL CHECK (quantity > 0),
  unit_price_cents bigint NOT NULL,
  line_total_cents bigint NOT NULL
);
CREATE INDEX offer_lines_offer_idx ON offer_lines(customer_id, offer_id, position);

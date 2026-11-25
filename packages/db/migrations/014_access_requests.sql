-- A request to become a customer, sent from the public site. The owner of the service approves or
-- declines it; only an approved address can create an account. Not a customer yet, so there is no
-- customer_id: these rows are only reached through the system layer.
CREATE TABLE access_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email        text NOT NULL UNIQUE,          -- the address that will sign in, lower case
  company      text NOT NULL,
  contact_name text NOT NULL,
  mail_system  text NOT NULL CHECK (mail_system IN ('microsoft365', 'gmail', 'other')),
  note         text,                          -- what they want help with, in their own words
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz
);
CREATE INDEX access_requests_created ON access_requests (created_at);

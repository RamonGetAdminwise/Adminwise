-- Billing details of the customer, for our own invoices to them.
--   billing_country   '' = not given yet, an EU country's ISO code, or 'OTHER' (outside the EU)
--   vat_status        none        no VAT number given (or a country without a register we can ask)
--                     valid       the EU register (VIES) confirmed it at vat_checked_at
--                     invalid     the EU register does not know it
--                     unverified  the register could not be reached; treated as not valid until it can
--   vat_registered_name  the name the register returned, shown to the owner so they can see it is theirs
ALTER TABLE customers
  ADD COLUMN billing_name text NOT NULL DEFAULT '',
  ADD COLUMN billing_address text NOT NULL DEFAULT '',
  ADD COLUMN billing_country text NOT NULL DEFAULT '',
  ADD COLUMN vat_number text NOT NULL DEFAULT '',
  ADD COLUMN vat_status text NOT NULL DEFAULT 'none' CHECK (vat_status IN ('none', 'valid', 'invalid', 'unverified')),
  ADD COLUMN vat_checked_at timestamptz,
  ADD COLUMN vat_registered_name text;

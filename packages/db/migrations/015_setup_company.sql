-- Guided setup: when the owner saved the first step ("Your company") themselves.
-- The company name is filled in from the request for access, so a filled-in name no longer
-- shows that the step was looked at. Accounts that already have a name saved it themselves.
ALTER TABLE customers ADD COLUMN setup_company_at timestamptz;
UPDATE customers SET setup_company_at = now() WHERE btrim(name) <> '';

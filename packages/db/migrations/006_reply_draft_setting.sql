-- Which incoming business mail gets a reply draft, chosen by each customer:
--   all    every business mail (the behaviour so far)
--   sales  only quote requests, acceptances of an offer, and replies about an invoice being chased
--   off    none
-- Follow-ups, filing, offers on request and payment reminders are not affected by "all" or "sales";
-- with "off" no reply drafts are written at all, so quote requests get no offer either.
ALTER TABLE customers
  ADD COLUMN reply_drafts text NOT NULL DEFAULT 'all' CHECK (reply_drafts IN ('all', 'sales', 'off'));

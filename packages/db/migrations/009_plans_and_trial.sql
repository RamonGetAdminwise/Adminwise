-- Plans, the free trial and what follows it.
--   plan            what the account pays for (or tries): 'start' or 'run'. A trial is on 'run'.
--   billing_status  trial      free trial until trial_ends_at
--                   active     paid subscription
--                   read_only  trial ended or payment stopped: nothing new is prepared; settings stay visible
--                   internal   our own accounts: free, everything on, never reminded or deleted
--   read_only_since            start of the 60 days after which a read-only account is deleted
--   stripe_*, current_period_end, cancel_at_period_end   kept in step with the payment provider
ALTER TABLE customers
  ADD COLUMN plan text NOT NULL DEFAULT 'run' CHECK (plan IN ('start', 'run')),
  ADD COLUMN billing_status text NOT NULL DEFAULT 'trial' CHECK (billing_status IN ('trial', 'active', 'read_only', 'internal')),
  ADD COLUMN trial_ends_at timestamptz NOT NULL DEFAULT (now() + interval '14 days'),
  ADD COLUMN trial_reminder_sent_at timestamptz,
  ADD COLUMN read_only_since timestamptz,
  ADD COLUMN deletion_warning_sent_at timestamptz,
  ADD COLUMN stripe_customer_id text UNIQUE,
  ADD COLUMN stripe_subscription_id text,
  ADD COLUMN current_period_end timestamptz,
  ADD COLUMN cancel_at_period_end boolean NOT NULL DEFAULT false;

-- Every account that exists when billing arrives is one of our own.
UPDATE customers SET billing_status = 'internal';

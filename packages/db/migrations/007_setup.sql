-- Guided setup ("Getting started").
--   setup_finished_at   when the owner finished or skipped the guide; null = still shown after sign-in
--   setup_test_sent_at  when the test mail of the guide was last sent to the owner (limits repeats)
--   offer_proposal      company details read from a sample document the owner uploaded, waiting for
--                       their "use these" or "discard"; holds only values printed on that document
ALTER TABLE customers
  ADD COLUMN setup_finished_at timestamptz,
  ADD COLUMN setup_test_sent_at timestamptz,
  ADD COLUMN offer_proposal jsonb;

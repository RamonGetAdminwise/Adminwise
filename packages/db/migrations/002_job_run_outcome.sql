-- What a job run actually did, in a short fixed code (never mail content):
-- "drafted", "no_draft:newsletter", "new_mail:2". Shown to the customer in
-- Recent activity, so "succeeded" no longer hides "no reply was needed".
ALTER TABLE job_runs ADD COLUMN outcome text;

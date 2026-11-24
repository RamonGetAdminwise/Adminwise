-- A sign of life from each background service, so that someone outside can see when one has stopped.
-- One row per service; no customer data.
CREATE TABLE heartbeats (
  name    text PRIMARY KEY,          -- 'worker'
  beat_at timestamptz NOT NULL
);

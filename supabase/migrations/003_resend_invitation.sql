-- Support the "Resend email" button: remember how often and when a fresh
-- survey link was last sent for a session, so it can be rate-limited.
alter table public.study_sessions
  add column if not exists resend_count integer not null default 0,
  add column if not exists last_resend_at timestamptz;

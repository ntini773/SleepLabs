-- Migration 004: track when a session was claimed for sending, so a stuck claim can be reset.
-- Safe to run more than once.

alter table public.study_sessions
  add column if not exists sending_started_at timestamptz;

-- Help the cron job find queued sessions quickly.
create index if not exists sessions_queued_for_email
  on public.study_sessions (release_at)
  where status = 'queued';

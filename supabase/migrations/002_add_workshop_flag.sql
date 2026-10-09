-- Migration 002: Add workshop flag, backfill, sending status, email_attempts, and unique participant_id constraint.

-- 1. Add from_workshop column to participants and backfill from roll_number
alter table public.participants
  add column if not exists from_workshop boolean not null default false;

update public.participants
  set from_workshop = true
  where roll_number is not null and trim(roll_number::text) != '';

-- 2. Add 'sending' to study_status enum
do $$ begin
  alter type public.study_status add value if not exists 'sending' after 'queued';
exception
  when duplicate_object then null;
end $$;

-- 3. Add email_attempts to study_sessions
alter table public.study_sessions
  add column if not exists email_attempts integer not null default 0;

-- 4. Add unique constraint on participant_id for study_sessions (one session per participant)
do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'study_sessions_participant_id_key'
  ) then
    alter table public.study_sessions add constraint study_sessions_participant_id_key unique (participant_id);
  end if;
end $$;

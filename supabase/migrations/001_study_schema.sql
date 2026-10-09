create extension if not exists pgcrypto;
create extension if not exists citext;

do $$ begin
  create type public.study_status as enum ('listening', 'queued', 'email_sent', 'survey_submitted', 'exited');
exception
  when duplicate_object then null;
end $$;

-- Contact information is intentionally separate from survey answers. Admin reporting uses
-- participant IDs and roll numbers; it never needs to expose email addresses.
create table if not exists public.participants (
  id uuid primary key default gen_random_uuid(),
  roll_number citext unique,
  email citext not null unique,
  display_name text,
  auth_user_id uuid unique references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.study_sessions (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null references public.participants(id) on delete cascade,
  device_token_hash text not null unique,
  condition_id text not null check (condition_id in ('condition-a', 'condition-b')),
  duration_seconds integer not null check (duration_seconds > 0),
  status public.study_status not null default 'listening',
  listened_seconds integer not null default 0,
  loop_count integer not null default 0,
  qualified_at timestamptz,
  release_at timestamptz,
  email_sent_at timestamptz,
  email_provider_id text,
  created_at timestamptz not null default now(),
  ended_at timestamptz
);

create table if not exists public.playback_events (
  id bigint generated always as identity primary key,
  session_id uuid not null references public.study_sessions(id) on delete cascade,
  event_type text not null check (event_type in ('play', 'loop_started', 'sleepy', 'exit')),
  position_seconds integer,
  created_at timestamptz not null default now()
);

create table if not exists public.survey_responses (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null unique references public.study_sessions(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  relaxed smallint not null check (relaxed between 1 and 10),
  sleepy smallint not null check (sleepy between 1 and 10),
  alert smallint not null check (alert between 1 and 10),
  pleasant smallint not null check (pleasant between 1 and 10),
  music_workshop text not null,
  headphones text not null,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists sessions_due_for_email on public.study_sessions (release_at) where status = 'queued';
create index if not exists sessions_by_participant on public.study_sessions (participant_id, created_at desc);

alter table public.participants enable row level security;
alter table public.study_sessions enable row level security;
alter table public.playback_events enable row level security;
alter table public.survey_responses enable row level security;
alter table public.admin_users enable row level security;

-- Grant service_role full table & sequence permissions
grant usage on schema public to anon, authenticated, service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant all on all functions in schema public to service_role;

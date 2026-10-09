-- Add from_workshop flag to participants so the admin dashboard and
-- future analyses can distinguish workshop vs general participants without
-- touching the email address.
alter table public.participants
  add column if not exists from_workshop boolean not null default false;

-- Add a comment so future maintainers understand the semantics.
comment on column public.participants.from_workshop is
  'True when the participant indicated they are from a music workshop at registration time.';

# Next Agent Task: Connect the Listening Study to Supabase

## Context

This is a Next.js 15 + TypeScript static-export app hosted on GitHub Pages. Supabase provides Postgres, Auth, Storage, and Edge Functions; Resend sends email.

Read `BACKEND_HANDOVER.md` and `supabase/README.md` first. Reuse the existing schema and functions, and inspect them for gaps before changing anything.

Relevant files:

- `app/study-app.tsx` — participant flow; currently simulated
- `app/admin/page.tsx` — partial admin view
- `supabase/migrations/001_study_schema.sql`
- `supabase/functions/`
- `BACKEND_HANDOVER.md`
- `.env.example`

## Goal

Connect the participant flow to Supabase so a participant can start a real session, listen to the randomly assigned audio, qualify after 90%, receive a survey invitation after the configured delay, and submit the survey once. Finish the admin sign-in and attempt-list flow.

## Requirements

### Participant start

- Collect full name and ask whether the participant is from a music workshop.
- If yes, require roll number and college email.
- If no, require only email.
- Persist the workshop answer in the database. Update the migration and start-session function because the current schema/function do not store it.
- Do not create another session for an already registered participant. Show a useful return-participant path instead.
- Randomly assign one of the two conditions with equal probability on the server.
- Return an opaque device token and store it for same-device return. Never expose database service credentials.

### Audio and qualification

- Replace simulated timer playback with the two audio files in Supabase Storage. If the files are unavailable in the workspace, build the player integration around clearly named configurable storage paths and document where to upload them.
- Do not show a pause control.
- Do not show “I’m sleepy” before 90% playback.
- Once 90% is reached, loop the configured segment and show “I’m sleepy”.
- On selection, stop playback and queue the invitation.
- Do not include an in-player Exit button.
- Record condition, listening seconds, qualification time, loop count, and session status.
- Validate event and qualification inputs server-side. Explain that browser playback telemetry can raise confidence but cannot prove someone listened.

### Delayed survey email and access

- Keep `SURVEY_DELAY_SECONDS=60` for the current test configuration.
- Ensure the scheduled email job runs every minute and sends only once per qualified session.
- Add an idempotency guard so retries do not send duplicates. Handle provider success/failure safely.
- Keep the survey inaccessible until the session is qualified, the release time has passed, the invitation was accepted by the email provider, and the participant is authenticated with the matching email.
- Support the emailed magic link and a returning participant using the original device.
- After successful submission, prevent additional attempts at the database and server levels. Retain the unique response-per-session constraint.

### Survey and admin

- Connect the existing survey fields to Supabase and preserve the one-submission rule.
- Finish admin sign-in with Supabase Auth.
- Restrict admin data through the `admin_users` role check.
- Admin reporting should show participant ID, roll number when present, workshop status, assigned condition, attempt status, listening duration, loop count, and survey completion.
- Never include participant emails in admin reporting responses.

### Security and setup

- Enable and retain RLS on participant/session/survey tables; browser clients must not get direct access to these tables.
- Keep service-role, Resend, and cron secrets in Supabase Edge Function secrets only.
- Update `.env.example` only with public frontend variables and placeholders.
- Update `supabase/README.md` with exact migration, deployment, email, cron, and admin setup instructions.
- Do not add credentials or real participant data to the repository.
- Keep the existing white visual design and mobile layout intact.

## Process

1. Inspect the current code and list the files you plan to change.
2. Implement the smallest complete end-to-end path.
3. Do not deploy to a real Supabase project or send real email unless credentials and explicit deployment instructions are provided.
4. If configuration is missing, provide precise setup steps and make local development show a clear configuration message.

## Done when

- TypeScript checks and `npm run build` pass.
- A local or mocked integration demonstrates start → listen → qualify → waiting → survey → completion.
- The survey cannot be accessed before email release, by another participant, or after it has already been submitted.
- Admin access is rejected for non-admin users.
- The setup guide clearly identifies remaining configuration that requires project credentials or audio files.

# Resting Notes — backend handover

## Product rules

- A participant enters full name and workshop answer at night. Workshop participants then provide roll number and college email; non-workshop participants provide only email.
- The server randomly assigns `condition-a` or `condition-b` with equal probability.
- Playback has no pause. The client reports events; qualification needs at least 90% of the configured duration.
- At the loop phase the participant may click **I’m sleepy**. This queues one invitation. There is no in-app Exit action.
- In the current test configuration, the invitation becomes due 60 seconds after qualification. Production must replace this with the agreed morning schedule.
- The survey is available only when: qualified, invitation accepted by the email provider, authenticated as the matching participant, and not already submitted.
- The admin interface may display participant ID and roll number for marks. It must not expose email addresses in its study-results response.

## Existing assets

| Asset | Purpose |
|---|---|
| `supabase/migrations/001_study_schema.sql` | Database types, tables, indexes, and RLS. |
| `start-session` | Validates start details, assigns condition, creates opaque device token. |
| `qualify-session` | Checks 90% threshold and queues the invitation. |
| `morning-invitations` | Cron-only sender using Supabase Auth magic links and Resend. |
| `survey-access` | Authenticated availability check and single survey insertion. |
| `admin-dashboard` | Role-protected, email-free reporting data. |

## Required deployment sequence

1. Create a Supabase project.
2. Run the SQL migration.
3. Create a Resend account and verify a sending domain.
4. Configure Resend as Supabase Auth custom SMTP; add the deployed GitHub Pages URL to Auth redirect URLs.
5. Set Edge Function secrets: `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, `RESEND_FROM`, `APP_URL`, `CRON_SECRET`, and `SURVEY_DELAY_SECONDS=60`.
6. Deploy all five Edge Functions listed in `supabase/README.md`.
7. Create an Auth account for each administrator and insert its UUID into `admin_users`.
8. Schedule `morning-invitations` once per minute using Supabase Cron and a Vault-held `CRON_SECRET`.

## Frontend integration contract

The Next.js static site must call functions at:

`{NEXT_PUBLIC_SUPABASE_URL}/functions/v1/{function-name}`

Send public `apikey: NEXT_PUBLIC_SUPABASE_ANON_KEY` on browser calls. Never ship the service-role key.

### Start

`POST start-session`

```json
{ "displayName": "Student Name", "rollNumber": "24MUS001", "email": "student@college.edu", "workshop": "yes" }
```

Persist only returned `deviceToken` locally. It is an opaque bearer credential; do not display it.

### Qualification

`POST qualify-session`

```json
{ "deviceToken": "opaque-token", "listenedSeconds": 162, "loopCount": 1 }
```

The UI must not show a survey form after this response. Show the waiting screen.

### Survey

The magic link adds an `access_token` to the return URL. Read it, then call `POST survey-access` with `Authorization: Bearer <access_token>`. First send `{ "action": "check" }`; display the form only when `available: true`. Submit the rating payload with `{ "action": "submit", ... }`.

### Returning participant

If a valid local `deviceToken` exists, call a small `study-status` function (still to be added) to avoid showing the details page again. It must return only an allowed state such as `listening`, `waiting`, or `ready_needs_login`; it must never return email data.

## Missing work for the next agent

1. Replace simulated playback in `app/study-app.tsx` with `HTMLAudioElement` events from private Supabase Storage signed URLs.
2. Wire the start and qualification UI handlers to the deployed functions.
3. Add `study-status` and magic-link token handling, then wire the real survey form to `survey-access`.
4. Add a 90%-progress event stream (`play`, `timeupdate`, `loop_started`) and rate-limit event ingestion. Browser events improve auditability but cannot prove a person listened.
5. Add an administrator sign-in page that requests an admin magic link; the current `/admin` page only consumes an existing magic-link token.
6. Add automated tests for: <90% rejection, duplicate survey rejection, wrong-user rejection, and non-admin dashboard rejection.
7. Before real collection, change the 60-second testing delay to the agreed morning schedule and confirm institutional privacy/ethics requirements for storing roll numbers and email addresses.

## Security invariants

- RLS is enabled and browser clients have no direct table policies.
- Service-role credentials remain Edge Function secrets only.
- `survey_responses.session_id` is unique.
- Every server-side survey action rechecks participant identity and `email_sent_at`.
- Admin authorization is based on `admin_users`, not a frontend route or UI condition.

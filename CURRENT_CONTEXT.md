# Resting Notes — Current Project Context & Handover Status

> **Last Updated:** October 10, 2026  
> **Repository:** [SleepLabs (github.com/ntini773/SleepLabs)](https://github.com/ntini773/SleepLabs)  
> **Architecture:** Next.js 15 (TypeScript, Static Export) + Supabase (Postgres RLS, Auth, Storage, Edge Functions) + Resend (Email)

---

## 1. Executive Summary

All core requirements from `tasks.md` and `BACKEND_HANDOVER.md` have been fully implemented, verified, and pushed to the GitHub repository:

- **Participant Registration & Flow:** Collects name, workshop status (yes/no), roll number (for workshop participants), and email. Server randomly assigns `condition-a` or `condition-b` with equal probability.
- **Audio Player & Qualification:** Streams `wholetones.mpeg` (Condition A) and `Nilambari.mpeg` (Condition B) from private/public Supabase Storage. Plays without pause controls until the 90% duration threshold, whereupon it transitions into the loop phase and displays **"I'm sleepy"**. Includes an **Admin Skip button** (`⚡ Admin: Skip mandatory listening phase`) for instant testing.
- **Device Token & Returning Participants:** Saves an opaque device token in `localStorage`. Returning participants call the `study-status` edge function to resume their exact state without re-registering or exposing email addresses.
- **Delayed Survey & Idempotent Emailing:** Qualified sessions transition to `queued` with a release timestamp (`SURVEY_DELAY_SECONDS=60` for testing). The `morning-invitations` edge function generates single-use magic links and sends invitations via Resend with idempotency key protection.
- **Reflection Survey Access:** Single-submission rating form authenticated via magic link or email matching, with database-level unique constraint (`survey_responses.session_id`).
- **Admin Dashboard (`/admin`):** Role-protected view (requires membership in `public.admin_users`). Displays participant ID, roll number, workshop status, assigned condition, attempt status, listening duration, loop count, and survey completion status. **Never exposes participant email addresses in response payloads.**

---

## 2. Infrastructure & Environment Setup

### Active URLs & Configuration
- **Supabase Project URL:** `https://mgskbqlooctlaentgrez.supabase.co`
- **Public Anon / Publishable Key:** `sb_publishable_dGB_E5K4p1AchXVJHaCapw_b5OLldxn`
- **Audio Bucket Path:** `https://mgskbqlooctlaentgrez.supabase.co/storage/v1/object/public/Audio_files`
- **Audio Files Verified (HTTP 200 OK):**
  - `wholetones.mpeg` (Condition A)
  - `Nilambari.mpeg` (Condition B)

### Local Files
- [`.env.local`](file:///home/nitin/scratch/music/.env.local) — Active local development credentials.
- [`.env.example`](file:///home/nitin/scratch/music/.env.example) — Clean public frontend environment template.
- [`pixi.toml`](file:///home/nitin/scratch/music/pixi.toml) — Environment specification for Node 20 and task runners (`pixi run dev`, `pixi run build`, `pixi run supabase`, `pixi run deploy-functions`).

---

## 3. Supabase Database Schema

The database has been configured using two idempotent migration scripts:

1. [`supabase/migrations/001_study_schema.sql`](file:///home/nitin/scratch/music/supabase/migrations/001_study_schema.sql)
   - Enum type: `study_status` (`listening`, `queued`, `email_sent`, `survey_submitted`, `exited`).
   - Tables: `participants`, `study_sessions`, `playback_events`, `survey_responses`, `admin_users`.
   - Security: RLS enabled on all tables; direct browser table policies omitted. `service_role` permissions explicitly granted across schema, tables, sequences, and functions.
2. [`supabase/migrations/002_add_workshop_flag.sql`](file:///home/nitin/scratch/music/supabase/migrations/002_add_workshop_flag.sql)
   - Adds `from_workshop boolean not null default false` column to `public.participants`.

---

## 4. Deployed Supabase Edge Functions

All six edge functions are deployed to project `mgskbqlooctlaentgrez`:

| Function | Endpoint | Description |
|---|---|---|
| `start-session` | `/functions/v1/start-session` | Validates details, checks duplicate registration, persists `from_workshop`, assigns condition, generates opaque device token. |
| `qualify-session` | `/functions/v1/qualify-session` | Validates 90% listening threshold, records `sleepy` event, sets `release_at = now() + SURVEY_DELAY_SECONDS`. |
| `study-status` | `/functions/v1/study-status` | Validates device token and returns current session state enum (`listening`, `waiting`, `ready_needs_login`, `complete`) without email data. |
| `morning-invitations` | `/functions/v1/morning-invitations` | Cron sender (`x-cron-secret` protected). Generates Auth magic links and dispatches emails via Resend using `Idempotency-Key`. |
| `survey-access` | `/functions/v1/survey-access` | Checks magic link / email auth, verifies session qualification, handles single survey submission. |
| `admin-dashboard` | `/functions/v1/admin-dashboard` | Verifies `admin_users` membership and returns telemetry list (participant ID, roll number, workshop status, condition, status, duration, loop count, survey completion). |

---

## 5. Edge Function Secrets Configured

The following secrets are set in **Supabase Dashboard → Edge Functions → Secrets**:

| Secret | Value / Purpose |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Auto-injected / service-role secret |
| `RESEND_API_KEY` | `<YOUR_RESEND_API_KEY>` |
| `RESEND_FROM` | `Resting Notes <onboarding@resend.dev>` |
| `APP_URL` | `http://localhost:3000/` |
| `CRON_SECRET` | `a-random-secret-string-123` |
| `SURVEY_DELAY_SECONDS` | `60` |

---

## 6. How to Test End-to-End

### A. Participant Flow Testing
1. Ensure Next.js dev server is running (`pixi run dev` or `npm run dev`).
2. Open **[http://localhost:3000](http://localhost:3000)**.
3. Register with your testing email: `grandhi.sai@research.iiit.ac.in`.
4. On the listening screen, click **⚡ Admin: Skip mandatory listening phase** to jump straight to the loop phase.
5. Click **I'm sleepy**.
6. Wait 60 seconds (or trigger immediately via curl):
   ```bash
   curl -i -X POST https://mgskbqlooctlaentgrez.supabase.co/functions/v1/morning-invitations \
     -H "apikey: sb_publishable_dGB_E5K4p1AchXVJHaCapw_b5OLldxn" \
     -H "Authorization: Bearer sb_publishable_dGB_E5K4p1AchXVJHaCapw_b5OLldxn" \
     -H "x-cron-secret: a-random-secret-string-123"
   ```
7. Check your email inbox for the magic reflection link and complete the survey ratings.

### B. Admin Dashboard Testing
1. Add your email as an administrator in Supabase SQL Editor:
   ```sql
   -- Find your Auth user UUID from Supabase Auth -> Users:
   insert into public.admin_users (user_id) values ('YOUR_AUTH_USER_UUID');
   ```
2. Open **[http://localhost:3000/admin](http://localhost:3000/admin)**.
3. Enter your administrator email and click **Send sign-in link**.
4. Open the link from your email to access the live attempts table.

---

## 7. Pre-Launch Production Checklist

- [ ] Change `SURVEY_DELAY_SECONDS` in Edge Function secrets from `60` to production release schedule (e.g., `28800` for 8 hours).
- [ ] Verify a custom sending domain at [resend.com/domains](https://resend.com/domains) and update `RESEND_FROM` secret (e.g., `Resting Notes <study@yourdomain.com>`).
- [ ] Update `APP_URL` in Edge Function secrets to your production GitHub Pages URL.
- [ ] Configure Supabase Cron to trigger `morning-invitations` automatically every minute/hour.

# Supabase setup guide

Complete these steps in order before collecting real participant data.

---

## 1. Create a Supabase project

[supabase.com/dashboard](https://supabase.com/dashboard) → New project.

---

## 2. Run the database migrations

Open **SQL editor** in your project dashboard and run each file in order:

```sql
-- paste contents of supabase/migrations/001_study_schema.sql
-- paste contents of supabase/migrations/002_add_workshop_flag.sql
```

Both files are idempotent (`if not exists` guards). Run 001 first, then 002.

---

## 3. Upload audio files

1. Go to **Storage** → create a bucket named `audio`.
2. Set the bucket to **Public** (read-only; no RLS write policies needed for participants).
3. Upload your two audio files with **exact** names:
   - `condition-a.mp3`
   - `condition-b.mp3`
4. Note the public URL pattern:
   `https://<project-ref>.supabase.co/storage/v1/object/public/audio`

---

## 4. Configure Resend (email)

1. Create a [Resend](https://resend.com) account and verify a sending domain.
2. In Supabase → **Authentication → SMTP Settings**, enable **Custom SMTP** and enter Resend credentials.
3. In Supabase → **Authentication → URL Configuration**, add your GitHub Pages URL to **Redirect URLs**:
   ```
   https://your-name.github.io/your-repository/
   https://your-name.github.io/your-repository/admin
   ```

---

## 5. Set Edge Function secrets

In Supabase → **Edge Functions → Secrets**, add:

| Secret | Value |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Project Settings → API → service_role key |
| `RESEND_API_KEY` | From your Resend account |
| `RESEND_FROM` | `Resting Notes <study@your-domain.example>` |
| `APP_URL` | Your GitHub Pages URL with trailing slash |
| `CRON_SECRET` | A long random string (generate with `openssl rand -hex 32`) |
| `SURVEY_DELAY_SECONDS` | `60` for testing; change to a real schedule before live collection |

---

## 6. Deploy Edge Functions

```sh
supabase login
supabase link --project-ref your-project-ref

supabase functions deploy start-session
supabase functions deploy qualify-session
supabase functions deploy study-status
supabase functions deploy morning-invitations
supabase functions deploy survey-access
supabase functions deploy admin-dashboard
```

---

## 7. Schedule morning-invitations (cron)

In Supabase → **Cron Jobs** → New job:

- **Schedule**: `* * * * *` (every minute while testing)
- **Command type**: HTTP
- **URL**: `https://<project-ref>.supabase.co/functions/v1/morning-invitations`
- **Headers**:
  - `x-cron-secret`: reference the Vault-held `CRON_SECRET` value

The function is idempotent — each session receives at most one invitation regardless of how many times the cron fires.

---

## 8. Create administrator accounts

1. In Supabase → **Authentication → Users** → Invite user → enter admin email.
2. After the admin accepts the invite and their `auth.users` UUID is known, run:
   ```sql
   insert into public.admin_users (user_id) values ('AUTH_USER_UUID_HERE');
   ```
3. The admin signs in at `/admin` — the page sends a magic link to their email.
   The link must redirect to the `/admin` path so the token is consumed by the admin page.

---

## 9. Frontend environment variables

Copy `.env.example` to `.env.local` and fill in your values:

```
NEXT_PUBLIC_SUPABASE_URL=https://your-project-ref.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-public-anon-key
NEXT_PUBLIC_AUDIO_BASE_URL=https://your-project-ref.supabase.co/storage/v1/object/public/audio
```

For GitHub Pages, set these as repository secrets and inject them during your CI build.

---

## Remaining configuration before live participant collection

- [ ] Replace `SURVEY_DELAY_SECONDS=60` with the agreed morning release schedule
- [ ] Upload `condition-a.mp3` and `condition-b.mp3` to Supabase Storage
- [ ] Verify Resend domain and test the email flow end-to-end
- [ ] Confirm institutional privacy and ethics requirements for storing roll numbers and email addresses
- [ ] Change cron schedule from every-minute to the agreed production cadence

---

## Security invariants (do not change)

- RLS is enabled on all tables; browser clients have no direct table access policies.
- `SUPABASE_SERVICE_ROLE_KEY` lives only in Edge Function secrets — never in frontend env vars.
- `survey_responses.session_id` has a unique constraint preventing double submission.
- Admin authorization is enforced in the `admin-dashboard` Edge Function via `admin_users`, not by a UI condition.
- Survey access rechecks participant identity and `email_sent_at` on every request.

# Supabase setup

This folder holds the backend for the listening study:

- 7 Edge Functions in `supabase/functions/`
- 4 SQL migrations in `supabase/migrations/` (001 to 004)
- Resend for the survey email
- Supabase Auth for the survey magic link and admin sign-in

Use placeholders in this guide. Replace each `<NAME>` with your own value. Never commit real values.

---

## Edge Functions

| Function | Called by | Purpose |
|---|---|---|
| `start-session` | Browser | Creates the participant and session. Assigns a condition at random. Returns a device token. |
| `qualify-session` | Browser | Checks the listening time. Queues the survey email and sets `release_at`. |
| `study-status` | Browser | Returns the state for a returning device. Never returns email data. |
| `survey-access` | Browser, with the magic-link token | Checks access and saves the survey once. |
| `resend-invitation` | Browser | Sends the survey link again. Limited by cooldown and count. |
| `morning-invitations` | Cron job | Sends queued survey emails. Requires the `x-cron-secret` header. |
| `admin-dashboard` | Admin browser | Returns session data for admins. Never returns email addresses. |

`supabase/config.toml` sets `verify_jwt = false` for every function. Each function checks its own caller.
`_shared/` holds helper code. It is not a function.

---

## 1. Create the Supabase project

1. Open [supabase.com/dashboard](https://supabase.com/dashboard) and choose **New project**.
2. Note the project ref. It is the part of the project URL before `.supabase.co`.

---

## 2. Run the migrations

Run the files in this order. Each file can be run again without harm.

1. `001_study_schema.sql`: tables, enum types, and row-level security.
2. `002_add_workshop_flag.sql`: workshop flag, `sending` status, and `email_attempts`.
3. `003_resend_invitation.sql`: `resend_count` and `last_resend_at` for the resend limit.
4. `004_email_reliability.sql`: `sending_started_at` and a queue index.

**Option A, SQL editor:** open **SQL editor** in the dashboard. Paste each file and run it.

**Option B, CLI:**

```sh
npx supabase login
npx supabase link --project-ref <PROJECT_REF>
npx supabase db push
```

---

## 3. Upload the audio files

1. Open **Storage** and create a bucket named `audio`.
2. Set the bucket to **Public**. Participants only need read access.
3. Upload the two files with these exact names. The app loads them by name from `CONDITION_METADATA` in `app/study-app.tsx`:
   - `wholetones.mpeg` (condition A)
   - `Nilambari.mpeg` (condition B)

   If you use different file names, change `CONDITION_METADATA` first.
4. The public base URL has this form:
   `https://<PROJECT_REF>.supabase.co/storage/v1/object/public/audio`
5. Measure each file. The length in seconds must match `DURATION_CONDITION_A` and `DURATION_CONDITION_B` (step 6).

---

## 4. Set up Resend (email)

### 4a. Create a sending-only API key

1. In [Resend](https://resend.com), open **API Keys** and choose **Create API key**.
2. Set the permission to **Sending access** only.
3. Copy the key once. You will use it as `<RESEND_API_KEY>` in step 6.

### 4b. Verify a sending domain

1. In Resend, open **Domains** and choose **Add domain**. Enter `<YOUR_DOMAIN>`.
2. Resend shows DNS records (type, name, and value). **Copy the exact values from the Resend dashboard** into your DNS provider. Do not copy values from this guide. Resend creates new values for each domain.
3. Wait until Resend shows the domain as **Verified**.
4. Choose a sender address on that domain, for example `study@<YOUR_DOMAIN>`. This is `<FROM_ADDRESS>`.

Only a verified domain can send to participants. The default sender `onboarding@resend.dev` works only for the email address of your Resend account.

### 4c. Use Resend for Supabase Auth email (admin sign-in)

The admin sign-in link is sent by Supabase Auth, not by the functions.

1. In Supabase, open **Authentication > SMTP Settings** and turn on **Enable custom SMTP**.
2. Enter the host, port, username, and password from the SMTP section of the Resend dashboard. The password is the sending API key from step 4a.
3. Set the sender email to `<FROM_ADDRESS>`.

---

## 5. Set the Auth URLs

In Supabase, open **Authentication > URL Configuration**.

- **Site URL:** `<APP_URL>`, the GitHub Pages base URL with a trailing slash.
- **Redirect URLs:** add both lines:
  - `<APP_URL>**`
  - `<APP_URL>admin`

Example, for a project page: `https://<GITHUB_USER>.github.io/<REPO>/` and `https://<GITHUB_USER>.github.io/<REPO>/admin`.

The survey link and the admin link both go to these URLs. A link to any other URL is not allowed.

---

## 6. Set the Edge Function secrets

Run these commands in the project folder. Replace each placeholder with your real value.

```sh
npx supabase secrets set RESEND_API_KEY=<RESEND_API_KEY>
npx supabase secrets set 'RESEND_FROM=Resting Notes <<FROM_ADDRESS>>'
npx supabase secrets set CRON_SECRET=<CRON_SECRET>
npx supabase secrets set APP_URL=<APP_URL>
npx supabase secrets set ALLOWED_ORIGIN=<ORIGIN>
npx supabase secrets set SURVEY_DELAY_SECONDS=<SURVEY_DELAY_SECONDS>
npx supabase secrets set DURATION_CONDITION_A=<CONDITION_A_SECONDS>
npx supabase secrets set DURATION_CONDITION_B=<CONDITION_B_SECONDS>
```

| Secret | Value | Notes |
|---|---|---|
| `RESEND_API_KEY` | `<RESEND_API_KEY>` | Sending-only key from step 4a. |
| `RESEND_FROM` | `Resting Notes <<FROM_ADDRESS>>` | Must be on a verified domain. |
| `CRON_SECRET` | `<CRON_SECRET>` | Make one with `openssl rand -hex 32`. The same value goes in the Vault (step 8). |
| `APP_URL` | `<APP_URL>` | Base URL with a trailing slash. Survey links point here. |
| `ALLOWED_ORIGIN` | `<ORIGIN>` | Origin only, with no path. Example: `https://<GITHUB_USER>.github.io`. |
| `SURVEY_DELAY_SECONDS` | `<SURVEY_DELAY_SECONDS>` | Whole seconds from qualification to release. `60` for tests. Use the agreed morning schedule for real data. |
| `DURATION_CONDITION_A` | `<CONDITION_A_SECONDS>` | Length of the condition A audio in seconds. Default `180`. |
| `DURATION_CONDITION_B` | `<CONDITION_B_SECONDS>` | Length of the condition B audio in seconds. Default `180`. |

Do not set `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY`. Supabase provides them to Edge Functions. The CLI does not allow secret names that start with `SUPABASE_`.

---

## 7. Deploy the functions

Deploy all seven functions:

```sh
npx supabase functions deploy start-session
npx supabase functions deploy qualify-session
npx supabase functions deploy study-status
npx supabase functions deploy survey-access
npx supabase functions deploy resend-invitation
npx supabase functions deploy morning-invitations
npx supabase functions deploy admin-dashboard
```

Or run `pixi run deploy-functions` after `pixi run supabase link --project-ref <PROJECT_REF>`.

---

## 8. Schedule `morning-invitations`

The job runs every minute. It is safe to run often. Each session gets at most one email.

1. Open **Database > Extensions** and turn on `pg_cron`, `pg_net`, and `supabase_vault`.
2. Store the cron secret in Vault. The name must be `cron_secret`:

   ```sql
   select vault.create_secret('<CRON_SECRET>', 'cron_secret');
   ```

3. Create the job in the **SQL editor**:

   ```sql
   select cron.schedule(
     'morning-invitations',
     '* * * * *',
     $$
     select net.http_post(
       url := 'https://<PROJECT_REF>.supabase.co/functions/v1/morning-invitations',
       headers := jsonb_build_object(
         'Content-Type', 'application/json',
         'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
       ),
       body := '{}'::jsonb
     );
     $$
   );
   ```

4. Check the runs:

   ```sql
   select status, return_message, start_time
   from cron.job_run_details
   order by start_time desc
   limit 5;
   ```

The value in the Vault must match the `CRON_SECRET` function secret. If it does not match, the function returns `401`.

---

## 9. Create administrator accounts

1. In Supabase, open **Authentication > Users** and invite each administrator by email.
2. After the user exists, copy their user UUID and run:

   ```sql
   insert into public.admin_users (user_id) values ('<ADMIN_AUTH_USER_UUID>');
   ```

3. Administrators open `<APP_URL>admin`, enter their email, and open the link they receive. The dashboard checks `admin_users` on every request.

---

## 10. GitHub Pages and frontend settings

1. In the repository, open **Settings > Pages**. Under **Build and deployment**, set **Source** to **GitHub Actions**.
2. Open **Settings > Secrets and variables > Actions** and add these repository secrets:
   - `NEXT_PUBLIC_SUPABASE_URL` = `https://<PROJECT_REF>.supabase.co`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` = the public anon key from **Project Settings > API**
   - `NEXT_PUBLIC_AUDIO_BASE_URL` = `https://<PROJECT_REF>.supabase.co/storage/v1/object/public/audio`

   The build stops with an error if any of these is empty.
3. Push to `main`, or run the workflow by hand. The job summary shows `base_url` and `origin`. Use those values for `APP_URL` and `ALLOWED_ORIGIN`.

For local work, copy `.env.example` to `.env.local` and fill in the same public values. Leave `NEXT_PUBLIC_ENABLE_TEST_MODE` empty. Never set it in CI or in the real study.

---

## 11. Switch to a custom domain later

1. Add a DNS record. Make a `CNAME` record for `<SUBDOMAIN>` that points to `<GITHUB_USER>.github.io`.
2. In **Settings > Pages**, set **Custom domain** to `<SUBDOMAIN>`. Wait for the DNS check, then turn on **Enforce HTTPS**.
3. Run the deploy again. A root domain has no base path, so `base_path` changes. Read the new values in the job summary.
4. Update the function secrets:

   ```sh
   npx supabase secrets set APP_URL=<NEW_APP_URL>
   npx supabase secrets set ALLOWED_ORIGIN=<NEW_ORIGIN>
   ```

5. In **Authentication > URL Configuration**, set the new Site URL. Add the new redirect entries (`<NEW_APP_URL>**` and `<NEW_APP_URL>admin`). Remove the old ones after the switch works.
6. Redeploy `start-session`, `survey-access`, and the other functions only if you changed code. Secret changes take effect without a redeploy.

---

---

## Run the tests

The function tests use Deno. They do not need a Supabase project or a Resend account. The tests use an in-memory fake of the database and a fake email service.

```sh
npm run test:functions
```

This runs `deno test` on `supabase/functions/_tests/`. Deno runs through `npx`, so you do not need to install it first.

Check the frontend and the functions before you deploy:

```sh
npm run typecheck
npm run build
```

Set the public variables for `npm run build` if you do not have a `.env.local` file. Dummy values are enough for a build check.

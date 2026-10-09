import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/http.ts";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// Limits for each cron run.
const MAX_EMAIL_ATTEMPTS = 5; // after this many tries, a session needs a person to look at it
const MAX_SESSIONS_PER_RUN = 20;
const STALE_SENDING_MINUTES = 10; // a "sending" claim older than this was probably abandoned
const DB_SAVE_RETRIES = 3; // extra tries for the "email_sent" save, after Resend accepted the email
const DB_SAVE_RETRY_DELAY_MS = 500;

type Candidate = {
  id: string;
  participant_id: string;
  email_attempts: number;
  participants: { email: string } | null;
};

type SendOutcome =
  | { outcome: "sent" }
  | { outcome: "skipped" } // another worker claimed it first
  | { outcome: "failed"; error: string };

// Logs must never contain a participant email. This hides anything that looks like one.
function hideEmails(text: string) {
  return text.replace(/[^\s@]+@[^\s@]+/g, "[email hidden]");
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// Puts a claimed session back in the queue and counts the failed attempt.
async function releaseClaim(sessionId: string, attemptsAfter: number) {
  const { error } = await admin
    .from("study_sessions")
    .update({ status: "queued", email_attempts: attemptsAfter })
    .eq("id", sessionId)
    .eq("status", "sending");
  if (error) console.error(`session ${sessionId}: could not return to queue: ${hideEmails(error.message)}`);
}

// A session stuck in "sending" (for example, the run stopped mid-send) goes back to the queue.
async function resetStaleSessions(): Promise<number> {
  const staleBefore = new Date(Date.now() - STALE_SENDING_MINUTES * 60_000).toISOString();
  const { data: stale, error } = await admin
    .from("study_sessions")
    .select("id, email_attempts")
    .eq("status", "sending")
    .is("email_sent_at", null)
    .or(`sending_started_at.is.null,sending_started_at.lt.${staleBefore}`);

  if (error) {
    console.error(`Could not check stale sessions: ${hideEmails(error.message)}`);
    return 0;
  }
  for (const row of stale ?? []) {
    await releaseClaim(row.id, row.email_attempts + 1);
  }
  return stale?.length ?? 0;
}

// Saves "email_sent". Resend already accepted the email, so this save is retried.
async function markEmailSent(sessionId: string, attempt: number, providerId: string | null): Promise<boolean> {
  for (let tryNumber = 0; tryNumber <= DB_SAVE_RETRIES; tryNumber++) {
    if (tryNumber > 0) await sleep(DB_SAVE_RETRY_DELAY_MS * tryNumber);
    const { error } = await admin
      .from("study_sessions")
      .update({
        status: "email_sent",
        email_sent_at: new Date().toISOString(),
        email_provider_id: providerId,
        email_attempts: attempt,
      })
      .eq("id", sessionId)
      .eq("status", "sending");
    if (!error) return true;
    console.error(`session ${sessionId}: could not save email_sent (try ${tryNumber + 1}): ${hideEmails(error.message)}`);
  }
  return false;
}

async function sendInvitation(
  session: Candidate,
  resendApiKey: string,
  resendFrom: string,
  appUrl: string,
): Promise<SendOutcome> {
  const participantEmail = session.participants?.email;
  if (!participantEmail) {
    return { outcome: "failed", error: `session ${session.id}: participant record missing` };
  }

  // 1. Claim queued -> sending. Only one worker can win this update.
  const { data: claimed, error: claimError } = await admin
    .from("study_sessions")
    .update({ status: "sending", sending_started_at: new Date().toISOString() })
    .eq("id", session.id)
    .eq("status", "queued")
    .lt("email_attempts", MAX_EMAIL_ATTEMPTS)
    .select("id, email_attempts")
    .maybeSingle();

  if (claimError) {
    console.error(`session ${session.id}: claim failed: ${hideEmails(claimError.message)}`);
    return { outcome: "failed", error: `session ${session.id}: could not claim` };
  }
  if (!claimed) return { outcome: "skipped" };

  // This attempt number is part of the Resend key, so each new try gets its own key.
  const attempt = claimed.email_attempts + 1;

  // 2. Create a Supabase Auth magic link.
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: participantEmail,
    options: { redirectTo: appUrl },
  });
  if (linkError || !link?.properties?.action_link) {
    console.error(`session ${session.id}: magic link failed: ${hideEmails(linkError?.message ?? "no action link")}`);
    await releaseClaim(session.id, attempt);
    return { outcome: "failed", error: `session ${session.id}: magic link failed` };
  }

  // 3. Save the auth user first, so a clicked link can always be matched to the participant.
  const { error: participantUpdateError } = await admin
    .from("participants")
    .update({ auth_user_id: link.user.id })
    .eq("id", session.participant_id);
  if (participantUpdateError) {
    console.error(`session ${session.id}: could not save auth link: ${hideEmails(participantUpdateError.message)}`);
    await releaseClaim(session.id, attempt);
    return { outcome: "failed", error: `session ${session.id}: could not save auth link` };
  }

  // 4. Send with Resend. The key changes with each attempt.
  let emailResponse: Response;
  try {
    emailResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `rn-invite-${session.id}-${attempt}`,
      },
      body: JSON.stringify({
        from: resendFrom,
        to: [participantEmail],
        subject: "Your morning reflection is ready",
        html: `
<p>Good morning.</p>
<p>Your listening reflection is ready. Open the link below to complete it.</p>
<p><a href="${link.properties.action_link}">Open your reflection →</a></p>
<p>The link signs you in automatically and can be used once. If you receive more than one email, use the newest one.</p>
<p style="color:#999;font-size:12px">If you did not participate in the Resting Notes study, you can ignore this email.</p>
        `.trim(),
      }),
    });
  } catch (error) {
    console.error(`session ${session.id}: Resend request failed: ${hideEmails(String(error))}`);
    await releaseClaim(session.id, attempt);
    return { outcome: "failed", error: `session ${session.id}: Resend request failed` };
  }

  if (!emailResponse.ok) {
    const errorText = await emailResponse.text().catch(() => "");
    console.error(`session ${session.id}: Resend returned ${emailResponse.status}: ${hideEmails(errorText)}`);
    await releaseClaim(session.id, attempt);
    return { outcome: "failed", error: `session ${session.id}: Resend returned ${emailResponse.status}` };
  }

  // 5. Resend accepted the email. Record that now.
  const provider = (await emailResponse.json().catch(() => ({}))) as { id?: string };
  const saved = await markEmailSent(session.id, attempt, provider.id ?? null);
  if (!saved) {
    return { outcome: "failed", error: `session ${session.id}: email accepted but status not saved` };
  }
  return { outcome: "sent" };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Fail closed: if the secret is not set, nobody can run the job.
  const expectedSecret = Deno.env.get("CRON_SECRET");
  if (!expectedSecret || request.headers.get("x-cron-secret") !== expectedSecret) {
    return json({ error: "Unauthorized" }, 401);
  }

  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  if (!resendApiKey) {
    console.error("RESEND_API_KEY is not set in Edge Function secrets.");
    return json({ error: "Email sending is not configured." }, 500);
  }
  const resendFrom = Deno.env.get("RESEND_FROM") ?? "onboarding@resend.dev";
  const appUrl = Deno.env.get("APP_URL") ?? "http://localhost:3000/";

  const staleReset = await resetStaleSessions();

  const { data: candidates, error: dbError } = await admin
    .from("study_sessions")
    .select("id, participant_id, email_attempts, participants(email)")
    .eq("status", "queued")
    .lte("release_at", new Date().toISOString())
    .is("email_sent_at", null)
    .lt("email_attempts", MAX_EMAIL_ATTEMPTS)
    .order("release_at", { ascending: true })
    .limit(MAX_SESSIONS_PER_RUN);

  if (dbError) {
    console.error(`Could not load queued sessions: ${hideEmails(dbError.message)}`);
    return json({ error: "Could not load queued invitations." }, 500);
  }

  let sent = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const session of (candidates ?? []) as unknown as Candidate[]) {
    let result: SendOutcome;
    try {
      result = await sendInvitation(session, resendApiKey, resendFrom, appUrl);
    } catch (error) {
      // Unexpected. The session stays "sending" and the stale reset will recover it.
      console.error(`session ${session.id}: unexpected error: ${hideEmails(String(error))}`);
      result = { outcome: "failed", error: `session ${session.id}: unexpected error` };
    }

    if (result.outcome === "sent") sent++;
    if (result.outcome === "failed") {
      failed++;
      errors.push(result.error);
    }
  }

  return json({ sent, failed, staleReset, errors });
});

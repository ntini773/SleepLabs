import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/http.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

// Cron-only function — rejects requests without the shared secret.
// Idempotency: a session's status transitions from 'queued' → 'email_sent' only
// after a confirmed provider success. If the cron fires again before the update
// commits (crash window), the session still has status='queued' and email_sent_at=NULL,
// so it will be retried — that is safe because we check email_sent_at IS NULL.
// Resend de-duplicates on their side for the same idempotency key when provided.
Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.headers.get("x-cron-secret") !== Deno.env.get("CRON_SECRET")) {
    return json({ error: "Unauthorized" }, 401);
  }

  // Fetch sessions that are: qualified, past release time, NOT yet emailed.
  const { data: sessions } = await admin
    .from("study_sessions")
    .select("id, participant_id, participants(email)")
    .eq("status", "queued")
    .lte("release_at", new Date().toISOString())
    .is("email_sent_at", null)
    .limit(100);

  let sent = 0;
  let failed = 0;

  for (const session of sessions ?? []) {
    const email = (session.participants as unknown as { email: string }).email;

    // Generate a Supabase Auth magic link for this participant.
    const { data: link, error: linkError } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email,
      options: { redirectTo: Deno.env.get("APP_URL") },
    });
    if (linkError || !link?.properties?.action_link) {
      console.error("Failed to generate magic link for session", session.id, linkError?.message);
      failed++;
      continue;
    }

    // Send via Resend with an idempotency key so provider-side retries are safe.
    const idempotencyKey = `rn-invite-${session.id}`;
    const emailResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({
        from: Deno.env.get("RESEND_FROM"),
        to: [email],
        subject: "Your morning reflection is ready",
        html: `
<p>Good morning.</p>
<p>Your listening reflection is ready. Open the link below to complete it.</p>
<p><a href="${link.properties.action_link}">Open your reflection →</a></p>
<p>The link signs you in automatically. It is single-use and expires after 24 hours.</p>
<p style="color:#999;font-size:12px">If you did not participate in the Resting Notes study, you can ignore this email.</p>
        `.trim(),
      }),
    });

    if (!emailResponse.ok) {
      const errorText = await emailResponse.text().catch(() => "unknown");
      console.error("Resend error for session", session.id, emailResponse.status, errorText);
      failed++;
      continue;
    }

    const provider = await emailResponse.json();

    // Mark as sent — this is the idempotency commit point. If this update fails,
    // the next cron run will retry (email_sent_at is still NULL).
    const { error: updateError } = await admin
      .from("study_sessions")
      .update({
        status: "email_sent",
        email_sent_at: new Date().toISOString(),
        email_provider_id: provider.id ?? null,
      })
      .eq("id", session.id);

    if (updateError) {
      console.error("Failed to mark email_sent for session", session.id, updateError.message);
      // Resend has the idempotency key so a duplicate send won't occur on the next run;
      // the DB update will be retried.
      failed++;
      continue;
    }

    // Persist auth_user_id so survey-access can match participant → auth user.
    await admin
      .from("participants")
      .update({ auth_user_id: link.user.id })
      .eq("id", session.participant_id);

    sent++;
  }

  return json({ sent, failed });
});

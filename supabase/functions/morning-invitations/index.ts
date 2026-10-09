import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/http.ts";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.headers.get("x-cron-secret") !== Deno.env.get("CRON_SECRET")) {
    return json({ error: "Unauthorized" }, 401);
  }

  // Fetch candidate queued sessions
  const { data: sessions, error: dbError } = await admin
    .from("study_sessions")
    .select("id, participant_id, email_attempts, participants(email)")
    .eq("status", "queued")
    .lte("release_at", new Date().toISOString())
    .is("email_sent_at", null)
    .limit(100);

  if (dbError) {
    return json({ error: `Database error: ${dbError.message}` }, 500);
  }

  let sent = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const session of sessions ?? []) {
    const email = (session.participants as unknown as { email: string }).email;

    // 1. Atomically claim queued -> sending
    const { data: claimedSession, error: claimError } = await admin
      .from("study_sessions")
      .update({ status: "sending" })
      .eq("id", session.id)
      .eq("status", "queued")
      .select("id, email_attempts")
      .maybeSingle();

    if (claimError || !claimedSession) {
      // Session was claimed by another worker or status changed; skip
      continue;
    }

    const currentAttempts = claimedSession.email_attempts ?? 0;

    // 2. Generate Supabase Auth magic link
    const { data: link, error: linkError } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email,
      options: { redirectTo: Deno.env.get("APP_URL") ?? "http://localhost:3000/" },
    });

    if (linkError || !link?.properties?.action_link) {
      const msg = `Magic link error for ${email}: ${linkError?.message ?? "no action_link"}`;
      console.error(msg);
      errors.push(msg);
      failed++;
      const { error: revertError } = await admin
        .from("study_sessions")
        .update({ status: "queued", email_attempts: currentAttempts + 1 })
        .eq("id", session.id);
      if (revertError) console.error(`Revert error: ${revertError.message}`);
      continue;
    }

    // 3. Save auth_user_id FIRST on participants table before emailing
    const { error: participantUpdateError } = await admin
      .from("participants")
      .update({ auth_user_id: link.user.id })
      .eq("id", session.participant_id);

    if (participantUpdateError) {
      const msg = `Participant auth link error for ${email}: ${participantUpdateError.message}`;
      console.error(msg);
      errors.push(msg);
      failed++;
      const { error: revertError } = await admin
        .from("study_sessions")
        .update({ status: "queued", email_attempts: currentAttempts + 1 })
        .eq("id", session.id);
      if (revertError) console.error(`Revert error: ${revertError.message}`);
      continue;
    }

    // 4. Send via Resend with idempotency key
    const idempotencyKey = `rn-invite-${session.id}`;
    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    const resendFrom = Deno.env.get("RESEND_FROM") ?? "onboarding@resend.dev";

    if (!resendApiKey) {
      const msg = "RESEND_API_KEY is not configured in Edge Function secrets.";
      console.error(msg);
      errors.push(msg);
      failed++;
      const { error: revertError } = await admin
        .from("study_sessions")
        .update({ status: "queued", email_attempts: currentAttempts + 1 })
        .eq("id", session.id);
      if (revertError) console.error(`Revert error: ${revertError.message}`);
      continue;
    }

    const emailResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({
        from: resendFrom,
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
      const msg = `Resend error (${emailResponse.status}): ${errorText}`;
      console.error(msg);
      errors.push(msg);
      failed++;
      const { error: revertError } = await admin
        .from("study_sessions")
        .update({ status: "queued", email_attempts: currentAttempts + 1 })
        .eq("id", session.id);
      if (revertError) console.error(`Revert error: ${revertError.message}`);
      continue;
    }

    const provider = await emailResponse.json();

    // 5. Mark as email_sent and record attempt
    const { error: sessionUpdateError } = await admin
      .from("study_sessions")
      .update({
        status: "email_sent",
        email_sent_at: new Date().toISOString(),
        email_provider_id: provider.id ?? null,
        email_attempts: currentAttempts + 1,
      })
      .eq("id", session.id);

    if (sessionUpdateError) {
      const msg = `Update session status error for ${session.id}: ${sessionUpdateError.message}`;
      console.error(msg);
      errors.push(msg);
      failed++;
      continue;
    }

    sent++;
  }

  return json({ sent, failed, errors });
});

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, hash, json } from "../_shared/http.ts";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const COOLDOWN_SECONDS = 300; // minimum gap between two sends for one session
const MAX_RESENDS = 3; // per session, on top of the first automatic email

type Session = {
  id: string;
  participant_id: string;
  status: string;
  release_at: string | null;
  email_sent_at: string | null;
  resend_count: number;
  last_resend_at: string | null;
};
const SESSION_COLUMNS = "id, participant_id, status, release_at, email_sent_at, resend_count, last_resend_at";

// Lets a participant ask for a fresh survey link when the first email did not arrive.
//
// Who is asking is identified by EITHER the device token (waiting screen) OR the
// email / roll number they registered with (already-registered screen).
//
// Rules:
// - Not before the preset wait time. `release_at` was set at qualification as
//   qualified_at + SURVEY_DELAY_SECONDS, so the delay setting controls this too.
// - The link is ALWAYS sent to the email stored at registration, never to what was typed.
// - If the first email is still queued or being sent, we do nothing; the cron job owns that.
// - Rate limited per session (cooldown + max count), claimed atomically before sending.
// - Replies never contain an email address.
Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const body = await request.json().catch(() => ({}));
  const deviceToken = typeof body.deviceToken === "string" ? body.deviceToken : "";

  let session: Session | null = null;
  if (deviceToken) {
    const { data } = await admin
      .from("study_sessions")
      .select(SESSION_COLUMNS)
      .eq("device_token_hash", await hash(deviceToken))
      .maybeSingle();
    session = data;
  } else {
    const email = String(body.email ?? "").trim().toLowerCase();
    const rollNumber = String(body.rollNumber ?? "").trim();
    const emailOk = /^\S+@\S+\.\S+$/.test(email);
    const rollOk = /^[A-Za-z0-9/_-]{3,40}$/.test(rollNumber);
    if (!emailOk && !rollOk) return json({ error: "Enter the email or roll number you registered with." }, 400);

    // Plain equality lookups only. Never build filter strings from user input.
    let participantId: string | null = null;
    if (emailOk) {
      const { data } = await admin.from("participants").select("id").eq("email", email).maybeSingle();
      participantId = data?.id ?? null;
    }
    if (!participantId && rollOk) {
      const { data } = await admin.from("participants").select("id").eq("roll_number", rollNumber).maybeSingle();
      participantId = data?.id ?? null;
    }
    if (participantId) {
      const { data } = await admin
        .from("study_sessions")
        .select(SESSION_COLUMNS)
        .eq("participant_id", participantId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      session = data;
    }
  }

  // Unknown details look the same as "nothing to resend".
  if (!session) return json({ status: "not_ready" });
  if (session.status === "survey_submitted") return json({ status: "submitted" });
  if (!["queued", "sending", "email_sent"].includes(session.status)) return json({ status: "not_ready" });

  // Gate 1: the preset wait time must have passed.
  const releaseMs = session.release_at ? new Date(session.release_at).getTime() : NaN;
  if (!Number.isFinite(releaseMs) || releaseMs > Date.now()) {
    return json({ status: "too_early", availableAt: session.release_at });
  }
  // Gate 2: the first email is the cron job's job. Do not race it.
  if (session.status !== "email_sent") return json({ status: "pending" });

  // Gate 3: rate limit.
  if (session.resend_count >= MAX_RESENDS) return json({ status: "limit" }, 429);
  const lastSend = new Date(session.last_resend_at ?? session.email_sent_at ?? 0).getTime();
  const waitMs = COOLDOWN_SECONDS * 1000 - (Date.now() - lastSend);
  if (waitMs > 0) return json({ status: "too_soon", retryAfterSeconds: Math.ceil(waitMs / 1000) }, 429);

  // Claim this attempt atomically. A double-click or parallel request loses the race here.
  const attempt = session.resend_count + 1;
  const previous = { resend_count: session.resend_count, last_resend_at: session.last_resend_at };
  const { data: claimed } = await admin
    .from("study_sessions")
    .update({ resend_count: attempt, last_resend_at: new Date().toISOString() })
    .eq("id", session.id)
    .eq("status", "email_sent")
    .eq("resend_count", session.resend_count)
    .select("id")
    .maybeSingle();
  if (!claimed) return json({ status: "too_soon", retryAfterSeconds: COOLDOWN_SECONDS }, 429);

  // If anything below fails, give the attempt back so our error does not lock the person out.
  async function fail(reason: string) {
    console.error("resend-invitation failed for session", session!.id, reason);
    await admin.from("study_sessions").update(previous).eq("id", session!.id);
    return json({ status: "error", error: "Could not resend the email. Please try again in a moment." }, 502);
  }

  const { data: participant } = await admin
    .from("participants")
    .select("id, email")
    .eq("id", session.participant_id)
    .maybeSingle();
  if (!participant) return await fail("participant missing");

  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: participant.email,
    options: { redirectTo: Deno.env.get("APP_URL") ?? "http://localhost:3000/" },
  });
  if (linkError || !link?.properties?.action_link) return await fail(linkError?.message ?? "no action link");

  // Save the auth user BEFORE sending, so a clicked link can always be matched to the participant.
  const { error: authLinkError } = await admin
    .from("participants")
    .update({ auth_user_id: link.user.id })
    .eq("id", participant.id);
  if (authLinkError) return await fail(authLinkError.message);

  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  if (!resendApiKey) return await fail("RESEND_API_KEY is not configured");

  const emailResponse = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
      // Unique per attempt: each resend carries its own link, so it needs its own key.
      "Idempotency-Key": `rn-resend-${session.id}-${attempt}`,
    },
    body: JSON.stringify({
      from: Deno.env.get("RESEND_FROM") ?? "onboarding@resend.dev",
      to: [participant.email],
      subject: "Your reflection link (sent again)",
      html: `
<p>Hello again.</p>
<p>You asked us to send your listening reflection link again. Open the link below to complete it.</p>
<p><a href="${link.properties.action_link}">Open your reflection →</a></p>
<p>The link signs you in automatically and can be used once. Please use this newest email, because earlier links may no longer work.</p>
<p style="color:#999;font-size:12px">If you did not participate in the Resting Notes study, you can ignore this email.</p>
      `.trim(),
    }),
  });
  if (!emailResponse.ok) {
    const errorText = await emailResponse.text().catch(() => "unknown");
    return await fail(`Resend ${emailResponse.status} ${errorText}`);
  }

  return json({ status: "sent" });
});

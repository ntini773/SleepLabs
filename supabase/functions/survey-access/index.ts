import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, getBearer, json } from "../_shared/http.ts";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const token = getBearer(request);
  if (!token) {
    return json({ error: "No authorization bearer token provided." }, 401);
  }

  const { data: auth, error: authError } = await admin.auth.getUser(token);
  if (authError || !auth.user) {
    return json({ error: `Authentication failed: ${authError?.message ?? "Invalid token"}` }, 401);
  }

  const userEmail = auth.user.email?.toLowerCase();

  // Look up participant by auth_user_id OR email.
  let { data: participant } = await admin
    .from("participants")
    .select("id, auth_user_id")
    .eq("auth_user_id", auth.user.id)
    .maybeSingle();

  if (!participant && userEmail) {
    const { data: byEmail } = await admin
      .from("participants")
      .select("id, auth_user_id")
      .eq("email", userEmail)
      .maybeSingle();

    if (byEmail) {
      participant = byEmail;
      // Link auth_user_id for future fast lookups
      await admin
        .from("participants")
        .update({ auth_user_id: auth.user.id })
        .eq("id", byEmail.id);
    }
  }

  if (!participant) {
    return json({ error: `No participant record found for email ${userEmail ?? "unknown"}.` }, 403);
  }

  // Find latest session for this participant (accept status 'email_sent' or 'queued')
  const { data: session } = await admin
    .from("study_sessions")
    .select("id, status")
    .eq("participant_id", participant.id)
    .in("status", ["email_sent", "queued"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!session) {
    // Check if session was already submitted
    const { data: submittedSession } = await admin
      .from("study_sessions")
      .select("id")
      .eq("participant_id", participant.id)
      .eq("status", "survey_submitted")
      .limit(1)
      .maybeSingle();

    if (submittedSession) {
      return json({ available: false, submitted: true });
    }

    return json({ error: "Your reflection is not available yet. Please complete the listening session first." }, 403);
  }

  const { data: existing } = await admin
    .from("survey_responses")
    .select("id")
    .eq("session_id", session.id)
    .maybeSingle();

  if (existing) {
    return json({ available: false, submitted: true });
  }

  const body = await request.json().catch(() => ({ action: "check" }));
  if (body.action !== "submit") {
    return json({ available: true, submitted: false, participantId: participant.id });
  }

  const fields = ["relaxed", "sleepy", "alert", "pleasant"] as const;
  if (fields.some((field) => !Number.isInteger(body[field]) || body[field] < 1 || body[field] > 10)) {
    return json({ error: "All ratings must be between 1 and 10." }, 400);
  }

  const { error: insertError } = await admin
    .from("survey_responses")
    .insert({
      session_id: session.id,
      participant_id: participant.id,
      relaxed: body.relaxed,
      sleepy: body.sleepy,
      alert: body.alert,
      pleasant: body.pleasant,
      music_workshop: body.musicWorkshop ?? "no",
      headphones: body.headphones ?? "no",
      notes: body.notes || null,
    });

  if (insertError) {
    return json({ error: `Could not save reflection: ${insertError.message}` }, 409);
  }

  await admin
    .from("study_sessions")
    .update({ status: "survey_submitted" })
    .eq("id", session.id);

  return json({ available: false, submitted: true });
});

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, getBearer, json } from "../_shared/http.ts";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// Allowed answers. Keep these in line with the options in app/study-app.tsx.
const MUSIC_WORKSHOP_OPTIONS = ["yes_currently", "previously", "no", "prefer_not"];
const HEADPHONE_OPTIONS = ["yes", "no"];
const MAX_NOTES_CHARACTERS = 2000;

function isRating(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 10;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const token = getBearer(request);
  if (!token) {
    return json({ error: "No authorization bearer token provided." }, 401);
  }

  const { data: auth, error: authError } = await admin.auth.getUser(token);
  if (authError || !auth.user) {
    return json({ error: "Authentication failed." }, 401);
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
      // Matching by email is only safe when the address was confirmed by the magic link.
      if (!auth.user.email_confirmed_at) {
        return json({ error: "Please confirm your email address with the link we sent." }, 403);
      }
      participant = byEmail;
      // Link auth_user_id for future fast lookups.
      const { error: linkError } = await admin
        .from("participants")
        .update({ auth_user_id: auth.user.id })
        .eq("id", byEmail.id);
      if (linkError) console.error("Could not link auth user to participant:", linkError.message);
    }
  }

  if (!participant) {
    return json({ error: "No participant record found for this sign-in." }, 403);
  }

  // Only a released, email-sent session can be answered.
  const { data: session, error: sessionError } = await admin
    .from("study_sessions")
    .select("id, status, release_at")
    .eq("participant_id", participant.id)
    .eq("status", "email_sent")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (sessionError) {
    console.error("Could not load session for participant:", sessionError.message);
    return json({ error: "Could not check your reflection. Please try again later." }, 500);
  }

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

  // The release time must have passed (qualified_at + SURVEY_DELAY_SECONDS).
  const releaseMs = session.release_at ? new Date(session.release_at).getTime() : NaN;
  if (!Number.isFinite(releaseMs) || releaseMs > Date.now()) {
    return json({ error: "Your reflection is not available yet." }, 403);
  }

  const { data: existing } = await admin
    .from("survey_responses")
    .select("id")
    .eq("session_id", session.id)
    .maybeSingle();

  if (existing) {
    return json({ available: false, submitted: true });
  }

  const body = (await request.json().catch(() => ({ action: "check" }))) as Record<string, unknown>;
  if (body.action !== "submit") {
    return json({ available: true, submitted: false, participantId: participant.id });
  }

  if (!["relaxed", "sleepy", "alert", "pleasant"].every((field) => isRating(body[field]))) {
    return json({ error: "All ratings must be whole numbers from 1 to 10." }, 400);
  }
  if (typeof body.musicWorkshop !== "string" || !MUSIC_WORKSHOP_OPTIONS.includes(body.musicWorkshop)) {
    return json({ error: "Choose a valid answer for the workshop question." }, 400);
  }
  if (typeof body.headphones !== "string" || !HEADPHONE_OPTIONS.includes(body.headphones)) {
    return json({ error: "Choose a valid answer for the headphones question." }, 400);
  }
  const notes = typeof body.notes === "string" ? body.notes.trim() : "";
  if (Array.from(notes).length > MAX_NOTES_CHARACTERS) {
    return json({ error: `Notes must be ${MAX_NOTES_CHARACTERS} characters or fewer.` }, 400);
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
      music_workshop: body.musicWorkshop,
      headphones: body.headphones,
      notes: notes || null,
    });

  if (insertError) {
    console.error("Could not save survey response:", insertError.message);
    return json({ error: "Could not save your reflection. Please try again later." }, 409);
  }

  const { error: statusError } = await admin
    .from("study_sessions")
    .update({ status: "survey_submitted" })
    .eq("id", session.id);
  if (statusError) {
    console.error("Could not set survey_submitted for session", session.id, statusError.message);
  }

  return json({ available: false, submitted: true });
});

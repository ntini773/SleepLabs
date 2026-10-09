import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, hash, json } from "../_shared/http.ts";
import { logError } from "../_shared/log.ts";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
// Seconds between qualification and the survey email. A bad value stops this function at start-up.
function readSurveyDelaySeconds(): number {
  const raw = Deno.env.get("SURVEY_DELAY_SECONDS")?.trim();
  if (!raw) return 60;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("SURVEY_DELAY_SECONDS must be a whole number of seconds, 0 or more.");
  }
  return value;
}
const delaySeconds = readSurveyDelaySeconds();

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const body = await request.json().catch(() => ({}));
  const { deviceToken, listenedSeconds, loopCount } = body as Record<string, unknown>;

  const numListened = Number(listenedSeconds);
  const numLoops = Number(loopCount);
  if (!Number.isFinite(numListened) || numListened < 0 || !Number.isFinite(numLoops) || numLoops < 0) {
    return json({ error: "Invalid listenedSeconds or loopCount." }, 400);
  }

  const { data: session, error: sessionError } = await admin
    .from("study_sessions")
    .select("id, duration_seconds, status, created_at")
    .eq("device_token_hash", await hash(String(deviceToken ?? "")))
    .maybeSingle();

  if (sessionError || !session) return json({ error: "Session not found." }, 404);
  if (session.status !== "listening") return json({ error: "This session is no longer available." }, 409);

  // Check client-reported listened seconds
  if (numListened < Math.ceil(session.duration_seconds * 0.9)) {
    return json({ error: "Listening threshold has not been reached." }, 403);
  }

  // Require real elapsed wall-clock time since created_at >= 90% of duration_seconds
  const createdAtMs = new Date(session.created_at).getTime();
  const realElapsedSeconds = (Date.now() - createdAtMs) / 1000;
  const requiredSeconds = session.duration_seconds * 0.9;
  if (realElapsedSeconds < requiredSeconds) {
    return json({ error: "Playback duration threshold has not elapsed." }, 403);
  }

  const releaseAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
  const { error: updateError } = await admin
    .from("study_sessions")
    .update({
      status: "queued",
      listened_seconds: Math.floor(numListened),
      loop_count: Math.floor(numLoops),
      qualified_at: new Date().toISOString(),
      release_at: releaseAt,
      ended_at: new Date().toISOString(),
    })
    .eq("id", session.id);

  if (updateError) {
    logError("qualify-session: update failed:", updateError.message);
    return json({ error: "Could not save your progress. Please try again." }, 500);
  }

  const { error: eventError } = await admin.from("playback_events").insert({
    session_id: session.id,
    event_type: "sleepy",
    position_seconds: Math.floor(numListened),
  });
  if (eventError) logError("qualify-session: could not log sleepy event:", eventError.message);

  return json({ releaseAt });
});

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, hash, json } from "../_shared/http.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const delaySeconds = Number(Deno.env.get("SURVEY_DELAY_SECONDS") ?? "60");

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const { deviceToken, listenedSeconds, loopCount } = await request.json();
  const { data: session } = await admin.from("study_sessions").select("id, duration_seconds, status").eq("device_token_hash", await hash(deviceToken ?? "")).maybeSingle();
  if (!session) return json({ error: "Session not found." }, 404);
  if (session.status !== "listening") return json({ error: "This session is no longer available." }, 409);
  if (Number(listenedSeconds) < Math.ceil(session.duration_seconds * 0.9)) return json({ error: "Listening threshold has not been reached." }, 403);

  const releaseAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
  await admin.from("study_sessions").update({ status: "queued", listened_seconds: listenedSeconds, loop_count: loopCount, qualified_at: new Date().toISOString(), release_at: releaseAt, ended_at: new Date().toISOString() }).eq("id", session.id);
  await admin.from("playback_events").insert({ session_id: session.id, event_type: "sleepy", position_seconds: listenedSeconds });
  return json({ releaseAt });
});

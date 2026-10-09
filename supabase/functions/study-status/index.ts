import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, hash, json } from "../_shared/http.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

// Returns the current state for a device token holder so the frontend can
// skip the welcome form on return. Never returns email data.
// Possible states:
//   listening      — session exists, still in listening phase
//   waiting        — qualified and waiting for survey email
//   ready_needs_login — email has been sent; participant must sign in
//   complete       — survey already submitted
Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const body = await request.json().catch(() => ({}));
  const deviceToken: string = body.deviceToken ?? "";
  if (!deviceToken) return json({ error: "deviceToken is required." }, 400);

  const { data: session } = await admin
    .from("study_sessions")
    .select("id, condition_id, duration_seconds, status")
    .eq("device_token_hash", await hash(deviceToken))
    .maybeSingle();

  if (!session) return json({ error: "Session not found." }, 404);

  const stateMap: Record<string, string> = {
    listening: "listening",
    queued: "waiting",
    email_sent: "ready_needs_login",
    survey_submitted: "complete",
    exited: "complete",
  };

  return json({
    state: stateMap[session.status] ?? "listening",
    conditionId: session.condition_id,
    durationSeconds: session.duration_seconds,
  });
});

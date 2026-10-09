import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, getBearer, json } from "../_shared/http.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const { data: auth } = await admin.auth.getUser(getBearer(request));
  if (!auth.user) return json({ error: "Sign in through your survey email first." }, 401);
  const { data: participant } = await admin.from("participants").select("id").eq("auth_user_id", auth.user.id).maybeSingle();
  if (!participant) return json({ error: "No eligible participant record found." }, 403);
  const { data: session } = await admin.from("study_sessions").select("id").eq("participant_id", participant.id).eq("status", "email_sent").not("email_sent_at", "is", null).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!session) return json({ error: "Your reflection is not available yet." }, 403);
  const { data: existing } = await admin.from("survey_responses").select("id").eq("session_id", session.id).maybeSingle();
  if (existing) return json({ available: false, submitted: true });
  const body = await request.json().catch(() => ({ action: "check" }));
  if (body.action !== "submit") return json({ available: true, submitted: false, participantId: participant.id });
  const fields = ["relaxed", "sleepy", "alert", "pleasant"] as const;
  if (fields.some((field) => !Number.isInteger(body[field]) || body[field] < 1 || body[field] > 10)) return json({ error: "All ratings must be between 1 and 10." }, 400);
  const { error } = await admin.from("survey_responses").insert({ session_id: session.id, participant_id: participant.id, relaxed: body.relaxed, sleepy: body.sleepy, alert: body.alert, pleasant: body.pleasant, music_workshop: body.musicWorkshop, headphones: body.headphones, notes: body.notes || null });
  if (error) return json({ error: "This survey may already have been submitted." }, 409);
  await admin.from("study_sessions").update({ status: "survey_submitted" }).eq("id", session.id);
  return json({ submitted: true });
});

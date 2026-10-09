import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, getBearer, json } from "../_shared/http.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Authenticate the caller as a Supabase Auth user.
  const { data: auth } = await admin.auth.getUser(getBearer(request));
  if (!auth.user) return json({ error: "Sign in required." }, 401);

  // Authorization: caller must be in admin_users.
  const { data: role } = await admin
    .from("admin_users")
    .select("user_id")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (!role) return json({ error: "Administrator access required." }, 403);

  // Fetch sessions with participant join — never return email addresses.
  const { data: sessions } = await admin
    .from("study_sessions")
    .select("id, participant_id, condition_id, status, listened_seconds, loop_count, qualified_at, created_at")
    .order("created_at", { ascending: false })
    .limit(250);

  const ids = [...new Set((sessions ?? []).map((s) => s.participant_id))];
  const { data: participants } = await admin
    .from("participants")
    .select("id, roll_number, from_workshop")
    .in("id", ids);

  const participantMap = new Map(
    (participants ?? []).map((p) => [p.id, { rollNumber: p.roll_number ?? "—", workshopStatus: p.from_workshop ? "workshop" : "general" }]),
  );

  // Check which sessions have a survey response.
  const sessionIds = (sessions ?? []).map((s) => s.id);
  const { data: responses } = await admin
    .from("survey_responses")
    .select("session_id")
    .in("session_id", sessionIds);
  const submittedSet = new Set((responses ?? []).map((r) => r.session_id));

  return json({
    sessions: (sessions ?? []).map((s) => {
      const p = participantMap.get(s.participant_id);
      return {
        id: s.id,
        participantId: s.participant_id,
        rollNumber: p?.rollNumber ?? "—",
        workshopStatus: p?.workshopStatus ?? "general",
        conditionId: s.condition_id,
        status: s.status,
        listenedSeconds: s.listened_seconds,
        loopCount: s.loop_count,
        surveyComplete: submittedSet.has(s.id),
        qualifiedAt: s.qualified_at,
        createdAt: s.created_at,
      };
    }),
  });
});

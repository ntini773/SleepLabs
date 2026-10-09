import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, hash, json } from "../_shared/http.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const durations = { "condition-a": 180, "condition-b": 180 } as const;

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const body = await request.json().catch(() => ({}));
  const { email, rollNumber, displayName, workshop } = body as Record<string, string | undefined>;
  const fromWorkshop = workshop === "yes";

  // Validate required fields.
  if (!/^\S+@\S+\.\S+$/.test(email ?? "")) {
    return json({ error: fromWorkshop ? "Enter a valid college email." : "Enter a valid email." }, 400);
  }
  if (fromWorkshop && !/^[A-Za-z0-9/_-]{3,40}$/.test(rollNumber ?? "")) {
    return json({ error: "Enter a valid roll number." }, 400);
  }
  if (!String(displayName ?? "").trim()) {
    return json({ error: "Enter your full name." }, 400);
  }

  // Check for an existing participant record to avoid duplicate sessions.
  // For workshop participants, match on either email OR roll number so that
  // re-registration attempts with a different field still hit the guard.
  const duplicateFilter = fromWorkshop
    ? `email.eq.${email!.toLowerCase()},roll_number.eq.${rollNumber!.trim()}`
    : `email.eq.${email!.toLowerCase()}`;
  const { data: existing } = await admin
    .from("participants")
    .select("id")
    .or(duplicateFilter)
    .maybeSingle();
  if (existing) {
    return json(
      { error: "A session already exists for these details. Return using the same device or your survey email link." },
      409,
    );
  }

  // Create participant — persist from_workshop so admin reporting has it.
  const { data: participant, error: participantError } = await admin
    .from("participants")
    .insert({
      email: email!.toLowerCase(),
      roll_number: fromWorkshop ? rollNumber!.trim() : null,
      display_name: String(displayName ?? "").trim() || null,
      from_workshop: fromWorkshop,
    })
    .select("id")
    .single();
  if (participantError) return json({ error: "Could not start the session." }, 500);

  // Randomly assign condition server-side.
  const conditionId: keyof typeof durations = Math.random() < 0.5 ? "condition-a" : "condition-b";
  const deviceToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  const { data: session, error: sessionError } = await admin
    .from("study_sessions")
    .insert({
      participant_id: participant.id,
      device_token_hash: await hash(deviceToken),
      condition_id: conditionId,
      duration_seconds: durations[conditionId],
    })
    .select("id, condition_id, duration_seconds")
    .single();
  if (sessionError) return json({ error: "Could not create the listening session." }, 500);

  return json({
    sessionId: session.id,
    deviceToken,
    conditionId: session.condition_id,
    durationSeconds: session.duration_seconds,
  });
});

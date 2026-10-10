import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, hash, json } from "../_shared/http.ts";
import { logError } from "../_shared/log.ts";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
// Listening length for each condition, in seconds. These MUST equal the real length of the
// audio files in Storage (condition-a.mp3 and condition-b.mp3). If they differ, the 90%
// check and the loop timing will be wrong.
// A bad value stops this function at start-up, so no session can be created with a wrong length.
function readDurationSeconds(name: string, fallback: number): number {
  const raw = Deno.env.get(name)?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive whole number of seconds.`);
  }
  return value;
}

const durations = {
  "condition-a": readDurationSeconds("DURATION_CONDITION_A", 180),
  "condition-b": readDurationSeconds("DURATION_CONDITION_B", 180),
} as const;

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const body = await request.json().catch(() => ({}));
  const { email, rollNumber, displayName, workshop } = body as Record<string, string | undefined>;
  const fromWorkshop = workshop === "yes";

  const normalizedEmail = email?.toLowerCase().trim();
  const normalizedRoll = rollNumber?.trim();

  // Validate required fields.
  if (!/^\S+@\S+\.\S+$/.test(normalizedEmail ?? "")) {
    return json({ error: fromWorkshop ? "Enter a valid college email." : "Enter a valid email." }, 400);
  }
  if (fromWorkshop && !/^[A-Za-z0-9/_-]{3,40}$/.test(normalizedRoll ?? "")) {
    return json({ error: "Enter a valid roll number." }, 400);
  }
  if (!String(displayName ?? "").trim()) {
    return json({ error: "Enter your full name." }, 400);
  }

  // Parameterized lookups for existing email
  const { data: existingEmail } = await admin
    .from("participants")
    .select("id")
    .eq("email", normalizedEmail!)
    .maybeSingle();

  if (existingEmail) {
    return json(
      { error: "A session already exists for these details. Return using the same device or your survey email link." },
      409,
    );
  }

  // Parameterized lookup for existing roll_number (if workshop)
  if (fromWorkshop && normalizedRoll) {
    const { data: existingRoll } = await admin
      .from("participants")
      .select("id")
      .eq("roll_number", normalizedRoll)
      .maybeSingle();

    if (existingRoll) {
      return json(
        { error: "A session already exists for these details. Return using the same device or your survey email link." },
        409,
      );
    }
  }

  // Create participant — persist from_workshop so admin reporting has it.
  const { data: participant, error: participantError } = await admin
    .from("participants")
    .insert({
      email: normalizedEmail!,
      roll_number: fromWorkshop ? normalizedRoll : null,
      display_name: String(displayName ?? "").trim() || null,
      from_workshop: fromWorkshop,
    })
    .select("id")
    .single();

  if (participantError || !participant) {
    logError("start-session: participant insert failed:", participantError?.message ?? "no row returned");
    return json({ error: "Could not start your session. Please try again." }, 500);
  }

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

  if (sessionError || !session) {
    logError("start-session: session insert failed:", sessionError?.message ?? "no row returned");
    // Delete the orphan participant so the person can try again.
    const { error: cleanupError } = await admin.from("participants").delete().eq("id", participant.id);
    if (cleanupError) logError("start-session: could not remove orphan participant:", cleanupError.message);
    return json({ error: "Could not start your session. Please try again." }, 500);
  }

  return json({
    sessionId: session.id,
    deviceToken,
    conditionId: session.condition_id,
    durationSeconds: session.duration_seconds,
  });
});

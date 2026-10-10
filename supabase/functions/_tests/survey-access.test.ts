import assert from "node:assert/strict";
import { callFunction, isoFromNow, loadFunction, seedParticipant, seedSession, setupTest } from "./helpers.ts";
import { rowsOf, store } from "./fake_supabase.ts";

const EMAIL = "participant@example.com";
const TOKEN = "survey-access-token";
const AUTH_HEADERS = { Authorization: `Bearer ${TOKEN}` };

// Signs in a fake Supabase Auth user. By default the email is confirmed.
function signIn(overrides: { id?: string; email?: string; email_confirmed_at?: string | null } = {}) {
  store.usersByToken.set(TOKEN, {
    id: "auth-user-1",
    email: EMAIL,
    email_confirmed_at: "2026-10-10T00:00:00.000Z",
    ...overrides,
  });
}

// A participant whose survey has been sent and released.
async function releasedSession(sessionOverrides: Record<string, unknown> = {}) {
  const participant = seedParticipant({ email: EMAIL });
  const session = await seedSession(participant.id, "device-survey", {
    status: "email_sent",
    release_at: isoFromNow(-60),
    email_sent_at: isoFromNow(-60),
    ...sessionOverrides,
  });
  return { participant, session };
}

const validSubmission = {
  action: "submit",
  relaxed: 7,
  sleepy: 6,
  alert: 4,
  pleasant: 8,
  musicWorkshop: "no",
  headphones: "yes",
  notes: "Felt calm",
};

Deno.test("survey-access: rejects a queued session even after its release time", async () => {
  setupTest();
  const handler = await loadFunction("survey-access");
  signIn();
  await releasedSession({ status: "queued" });

  const response = await callFunction(handler, { action: "check" }, AUTH_HEADERS);

  assert.equal(response.status, 403);
});

Deno.test("survey-access: rejects an email_sent session before its release time", async () => {
  setupTest();
  const handler = await loadFunction("survey-access");
  signIn();
  await releasedSession({ release_at: isoFromNow(600) });

  const response = await callFunction(handler, { action: "check" }, AUTH_HEADERS);

  assert.equal(response.status, 403);
});

Deno.test("survey-access: rejects an unconfirmed email when matching by email", async () => {
  setupTest();
  const handler = await loadFunction("survey-access");
  signIn({ email_confirmed_at: null });
  const { participant } = await releasedSession();

  const response = await callFunction(handler, { action: "check" }, AUTH_HEADERS);

  assert.equal(response.status, 403);
  assert.equal(participant.auth_user_id, null, "participant must not be linked to an unconfirmed sign-in");
});

Deno.test("survey-access: check reports the survey as available", async () => {
  setupTest();
  const handler = await loadFunction("survey-access");
  signIn();
  await releasedSession();

  const response = await callFunction(handler, { action: "check" }, AUTH_HEADERS);

  assert.equal(response.status, 200);
  assert.equal(response.body.available, true);
  assert.equal(response.body.submitted, false);
});

Deno.test("survey-access: saves one submission and marks the session submitted", async () => {
  setupTest();
  const handler = await loadFunction("survey-access");
  signIn();
  const { participant, session } = await releasedSession();

  const response = await callFunction(handler, validSubmission, AUTH_HEADERS);

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { available: false, submitted: true });
  assert.equal(rowsOf("survey_responses").length, 1);
  assert.equal(rowsOf("survey_responses")[0].notes, "Felt calm");
  assert.equal(session.status, "survey_submitted");
  assert.equal(participant.auth_user_id, "auth-user-1", "email match links the sign-in to the participant");
});

Deno.test("survey-access: a second submission does not save again", async () => {
  setupTest();
  const handler = await loadFunction("survey-access");
  signIn();
  await releasedSession();
  await callFunction(handler, validSubmission, AUTH_HEADERS);

  const response = await callFunction(handler, validSubmission, AUTH_HEADERS);

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { available: false, submitted: true });
  assert.equal(rowsOf("survey_responses").length, 1);
});

Deno.test("survey-access: rejects invalid answers and notes over 2000 characters", async () => {
  setupTest();
  const handler = await loadFunction("survey-access");
  signIn();
  await releasedSession();

  const badWorkshop = await callFunction(handler, { ...validSubmission, musicWorkshop: "robot" }, AUTH_HEADERS);
  const badHeadphones = await callFunction(handler, { ...validSubmission, headphones: "maybe" }, AUTH_HEADERS);
  const longNotes = await callFunction(handler, { ...validSubmission, notes: "x".repeat(2001) }, AUTH_HEADERS);

  assert.equal(badWorkshop.status, 400);
  assert.equal(badHeadphones.status, 400);
  assert.equal(longNotes.status, 400);
  assert.equal(rowsOf("survey_responses").length, 0);
});

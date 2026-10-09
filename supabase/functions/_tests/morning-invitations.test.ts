import assert from "node:assert/strict";
import {
  callFunction,
  captureErrors,
  isoFromNow,
  loadFunction,
  resendBehaviour,
  resendCalls,
  seedParticipant,
  seedSession,
  setupTest,
} from "./helpers.ts";
import { rowsOf, store } from "./fake_supabase.ts";

const CRON = { "x-cron-secret": "test-cron-secret" };

// A session that is queued and already past its release time.
async function queuedSession(email: string, sessionOverrides: Record<string, unknown> = {}) {
  const participant = seedParticipant({ email });
  const session = await seedSession(participant.id, crypto.randomUUID(), {
    status: "queued",
    release_at: isoFromNow(-30),
    ...sessionOverrides,
  });
  return { participant, session };
}

Deno.test("morning-invitations: rejects a request without the cron secret", async () => {
  setupTest();
  const handler = await loadFunction("morning-invitations");
  await queuedSession("queued@example.com");

  const response = await callFunction(handler, {});

  assert.equal(response.status, 401);
  assert.equal(resendCalls.length, 0);
});

Deno.test("morning-invitations: claims a queued session and sends one email", async () => {
  setupTest();
  const handler = await loadFunction("morning-invitations");
  const { session } = await queuedSession("queued@example.com");

  const response = await callFunction(handler, {}, CRON);

  assert.equal(response.status, 200);
  assert.equal(response.body.sent, 1);
  assert.equal(response.body.failed, 0);
  assert.equal(session.status, "email_sent");
  assert.equal(session.email_attempts, 1);
  assert.ok(session.email_sent_at);

  assert.equal(resendCalls.length, 1);
  const [call] = resendCalls;
  assert.equal(call.headers["Idempotency-Key"], `rn-invite-${session.id}-1`);
  assert.deepEqual(call.body.to, ["queued@example.com"]);
  assert.match(call.body.html, /newest one/);
  assert.doesNotMatch(call.body.html, /24 hours/);
});

Deno.test("morning-invitations: resets a stale sending claim and sends again", async () => {
  setupTest();
  const handler = await loadFunction("morning-invitations");
  const { session } = await queuedSession("stale@example.com", {
    status: "sending",
    sending_started_at: isoFromNow(-1200), // 20 minutes ago, older than the 10 minute limit
  });

  const response = await callFunction(handler, {}, CRON);

  assert.equal(response.status, 200);
  assert.equal(response.body.staleReset, 1);
  assert.equal(response.body.sent, 1);
  assert.equal(session.status, "email_sent");
  assert.equal(session.email_attempts, 2, "the stale reset and the new send each count as an attempt");
  // The key uses the new attempt number, so Resend treats it as a new email.
  assert.equal(resendCalls[0].headers["Idempotency-Key"], `rn-invite-${session.id}-2`);
});

Deno.test("morning-invitations: leaves a recent sending claim alone", async () => {
  setupTest();
  const handler = await loadFunction("morning-invitations");
  const { session } = await queuedSession("busy@example.com", {
    status: "sending",
    sending_started_at: isoFromNow(-60), // one minute ago, still in progress
  });

  const response = await callFunction(handler, {}, CRON);

  assert.equal(response.status, 200);
  assert.equal(response.body.staleReset, 0);
  assert.equal(response.body.sent, 0);
  assert.equal(session.status, "sending");
  assert.equal(resendCalls.length, 0);
});

Deno.test("morning-invitations: does not send once the attempt limit is reached", async () => {
  setupTest();
  const handler = await loadFunction("morning-invitations");
  const { session } = await queuedSession("capped@example.com", { email_attempts: 5 });

  const response = await callFunction(handler, {}, CRON);

  assert.equal(response.status, 200);
  assert.equal(response.body.sent, 0);
  assert.equal(session.status, "queued");
  assert.equal(resendCalls.length, 0);
});

Deno.test("morning-invitations: uses a new Idempotency-Key for each attempt", async () => {
  setupTest();
  const handler = await loadFunction("morning-invitations");
  const { session } = await queuedSession("retry@example.com");

  resendBehaviour.status = 500;
  resendBehaviour.responseText = JSON.stringify({ message: "temporary failure" });
  const firstRun = await callFunction(handler, {}, CRON);
  assert.equal(firstRun.body.failed, 1);
  assert.equal(session.status, "queued", "a failed send goes back to the queue");
  assert.equal(session.email_attempts, 1);

  resendBehaviour.status = 200;
  resendBehaviour.responseText = JSON.stringify({ id: "email_retry" });
  const secondRun = await callFunction(handler, {}, CRON);
  assert.equal(secondRun.body.sent, 1);

  assert.deepEqual(
    resendCalls.map((call) => call.headers["Idempotency-Key"]),
    [`rn-invite-${session.id}-1`, `rn-invite-${session.id}-2`],
  );
});

Deno.test("morning-invitations: stops after the fifth failed attempt", async () => {
  setupTest();
  const handler = await loadFunction("morning-invitations");
  const { session } = await queuedSession("fifth@example.com", { email_attempts: 4 });
  resendBehaviour.status = 500;

  const failedRun = await callFunction(handler, {}, CRON);
  assert.equal(failedRun.body.failed, 1);
  assert.equal(session.email_attempts, 5);

  resendBehaviour.status = 200;
  const nextRun = await callFunction(handler, {}, CRON);
  assert.equal(nextRun.body.sent, 0);
  assert.equal(resendCalls.length, 1, "no new Resend call after the limit");
});

Deno.test("morning-invitations: processes at most 20 sessions per run", async () => {
  setupTest();
  const handler = await loadFunction("morning-invitations");
  for (let index = 0; index < 25; index++) {
    await queuedSession(`batch${index}@example.com`);
  }

  const response = await callFunction(handler, {}, CRON);

  assert.equal(response.body.sent, 20);
  assert.equal(resendCalls.length, 20);
  assert.equal(rowsOf("study_sessions").filter((row) => row.status === "queued").length, 5);
});

Deno.test("morning-invitations: keeps participant emails out of errors and logs", async () => {
  setupTest();
  const handler = await loadFunction("morning-invitations");
  const participantEmail = "private-person@example.com";
  const { session } = await queuedSession(participantEmail);
  // Resend echoes the address back in its error text. The function must hide it.
  resendBehaviour.status = 422;
  resendBehaviour.responseText = JSON.stringify({ message: `Invalid recipient ${participantEmail}` });

  const { result, lines } = await captureErrors(() => callFunction(handler, {}, CRON));

  assert.equal(result.body.failed, 1);
  assert.deepEqual(result.body.errors, [`session ${session.id}: Resend returned 422`]);
  const everything = [JSON.stringify(result.body), ...lines].join("\n");
  assert.ok(!everything.includes(participantEmail), "email must not appear in the response or logs");
  assert.ok(!everything.includes("@"), "no email-like text in the response or logs");
});

Deno.test("morning-invitations: saves the email_sent status again after a temporary database error", async () => {
  setupTest();
  const handler = await loadFunction("morning-invitations");
  const { session } = await queuedSession("save-retry@example.com");
  // Fail the first two writes that set status to email_sent. Resend has already accepted the email by then.
  store.failures.push({
    table: "study_sessions",
    op: "update",
    times: 2,
    message: "temporary database error",
    matchPayload: (payload) => payload.status === "email_sent",
  });

  const { result } = await captureErrors(() => callFunction(handler, {}, CRON));

  assert.equal(result.body.sent, 1);
  assert.equal(result.body.failed, 0);
  assert.equal(session.status, "email_sent");
  assert.equal(resendCalls.length, 1, "the email is sent once, not again for each save retry");
});

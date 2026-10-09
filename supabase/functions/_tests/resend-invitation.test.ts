import assert from "node:assert/strict";
import {
  callFunction,
  isoFromNow,
  loadFunction,
  resendBehaviour,
  resendCalls,
  seedParticipant,
  seedSession,
  sessionById,
  setupTest,
} from "./helpers.ts";

const DEVICE = "device-resend";
const EMAIL = "resend@example.com";

// A participant with one session. Pass overrides to set the status and times.
async function participantWithSession(sessionOverrides: Record<string, unknown> = {}, participantOverrides = {}) {
  const participant = seedParticipant({ email: EMAIL, ...participantOverrides });
  const session = await seedSession(participant.id, DEVICE, sessionOverrides);
  return { participant, session };
}

Deno.test("resend-invitation: refuses before the release time", async () => {
  setupTest();
  const handler = await loadFunction("resend-invitation");
  await participantWithSession({
    status: "email_sent",
    release_at: isoFromNow(600),
    email_sent_at: isoFromNow(-60),
  });

  const response = await callFunction(handler, { deviceToken: DEVICE });

  assert.equal(response.body.status, "too_early");
  assert.equal(resendCalls.length, 0);
});

Deno.test("resend-invitation: says pending while the first email is still queued", async () => {
  setupTest();
  const handler = await loadFunction("resend-invitation");
  await participantWithSession({ status: "queued", release_at: isoFromNow(-30) });

  const response = await callFunction(handler, { deviceToken: DEVICE });

  assert.equal(response.body.status, "pending");
  assert.equal(resendCalls.length, 0);
});

Deno.test("resend-invitation: enforces the 5 minute cooldown", async () => {
  setupTest();
  const handler = await loadFunction("resend-invitation");
  await participantWithSession({
    status: "email_sent",
    release_at: isoFromNow(-600),
    email_sent_at: isoFromNow(-60), // sent one minute ago
  });

  const response = await callFunction(handler, { deviceToken: DEVICE });

  assert.equal(response.status, 429);
  assert.equal(response.body.status, "too_soon");
  assert.ok(response.body.retryAfterSeconds > 0 && response.body.retryAfterSeconds <= 300);
  assert.equal(resendCalls.length, 0);
});

Deno.test("resend-invitation: stops after three resends", async () => {
  setupTest();
  const handler = await loadFunction("resend-invitation");
  await participantWithSession({
    status: "email_sent",
    release_at: isoFromNow(-7200),
    email_sent_at: isoFromNow(-3600),
    resend_count: 3,
  });

  const response = await callFunction(handler, { deviceToken: DEVICE });

  assert.equal(response.status, 429);
  assert.equal(response.body.status, "limit");
  assert.equal(resendCalls.length, 0);
});

Deno.test("resend-invitation: sends a new link to the stored address", async () => {
  setupTest();
  const handler = await loadFunction("resend-invitation");
  const { session } = await participantWithSession({
    status: "email_sent",
    release_at: isoFromNow(-3000),
    email_sent_at: isoFromNow(-3600),
  });

  const response = await callFunction(handler, { deviceToken: DEVICE });

  assert.equal(response.status, 200);
  assert.equal(response.body.status, "sent");
  assert.equal(session.resend_count, 1);
  assert.ok(session.last_resend_at);

  assert.equal(resendCalls.length, 1);
  assert.equal(resendCalls[0].headers["Idempotency-Key"], `rn-resend-${session.id}-1`);
  assert.deepEqual(resendCalls[0].body.to, [EMAIL]);
  assert.match(resendCalls[0].body.html, /can be used once/);
  // Replies never include an email address.
  assert.ok(!response.text.includes("@"));
});

Deno.test("resend-invitation: a details lookup sends to the stored address, not the typed one", async () => {
  setupTest();
  const handler = await loadFunction("resend-invitation");
  await participantWithSession(
    { status: "email_sent", release_at: isoFromNow(-3000), email_sent_at: isoFromNow(-3600) },
    { roll_number: "24MUS001" },
  );

  const response = await callFunction(handler, {
    email: "typo@example.com", // not registered, so the roll number is used
    rollNumber: "24MUS001",
  });

  assert.equal(response.body.status, "sent");
  assert.deepEqual(resendCalls[0].body.to, [EMAIL]);
});

Deno.test("resend-invitation: a Resend failure gives the attempt back", async () => {
  setupTest();
  const handler = await loadFunction("resend-invitation");
  const { session } = await participantWithSession({
    status: "email_sent",
    release_at: isoFromNow(-3000),
    email_sent_at: isoFromNow(-3600),
  });
  resendBehaviour.status = 500;

  const failed = await callFunction(handler, { deviceToken: DEVICE });

  assert.equal(failed.status, 502);
  assert.equal(failed.body.status, "error");
  assert.equal(sessionById(session.id)?.resend_count, 0, "the failed attempt does not count");
  assert.equal(sessionById(session.id)?.last_resend_at, null);

  resendBehaviour.status = 200;
  const retry = await callFunction(handler, { deviceToken: DEVICE });
  assert.equal(retry.body.status, "sent", "the participant can try again straight away");
});

Deno.test("resend-invitation: an unknown device token looks like nothing to resend", async () => {
  setupTest();
  const handler = await loadFunction("resend-invitation");
  await participantWithSession({ status: "email_sent", release_at: isoFromNow(-3000), email_sent_at: isoFromNow(-3600) });

  const response = await callFunction(handler, { deviceToken: "not-a-real-device" });

  assert.equal(response.body.status, "not_ready");
  assert.equal(resendCalls.length, 0);
});

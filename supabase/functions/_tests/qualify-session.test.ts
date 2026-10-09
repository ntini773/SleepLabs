import assert from "node:assert/strict";
import {
  callFunction,
  isoFromNow,
  loadFunction,
  seedParticipant,
  seedSession,
  sessionById,
  setupTest,
} from "./helpers.ts";
import { rowsOf } from "./fake_supabase.ts";

const DEVICE = "device-qualify";

// A listening session for a 180 second track that started `secondsAgo` seconds ago.
async function startListening(secondsAgo: number) {
  const participant = seedParticipant();
  return await seedSession(participant.id, DEVICE, {
    duration_seconds: 180,
    created_at: isoFromNow(-secondsAgo),
  });
}

Deno.test("qualify-session: rejects a missing listenedSeconds", async () => {
  setupTest();
  const handler = await loadFunction("qualify-session");
  await startListening(400);

  const response = await callFunction(handler, { deviceToken: DEVICE, loopCount: 1 });

  assert.equal(response.status, 400);
});

Deno.test("qualify-session: rejects a NaN listenedSeconds", async () => {
  setupTest();
  const handler = await loadFunction("qualify-session");
  await startListening(400);

  const response = await callFunction(handler, { deviceToken: DEVICE, listenedSeconds: "abc", loopCount: 1 });

  assert.equal(response.status, 400);
});

Deno.test("qualify-session: rejects a missing loopCount", async () => {
  setupTest();
  const handler = await loadFunction("qualify-session");
  await startListening(400);

  const response = await callFunction(handler, { deviceToken: DEVICE, listenedSeconds: 170 });

  assert.equal(response.status, 400);
});

Deno.test("qualify-session: rejects listening below 90 percent", async () => {
  setupTest();
  const handler = await loadFunction("qualify-session");
  const session = await startListening(400);

  const response = await callFunction(handler, { deviceToken: DEVICE, listenedSeconds: 100, loopCount: 0 });

  assert.equal(response.status, 403);
  assert.equal(sessionById(session.id)?.status, "listening");
});

Deno.test("qualify-session: rejects a session that is too fast", async () => {
  setupTest();
  const handler = await loadFunction("qualify-session");
  // The client reports 170 seconds, but only 10 seconds of real time have passed.
  const session = await startListening(10);

  const response = await callFunction(handler, { deviceToken: DEVICE, listenedSeconds: 170, loopCount: 1 });

  assert.equal(response.status, 403);
  assert.equal(sessionById(session.id)?.status, "listening");
});

Deno.test("qualify-session: queues the invitation and sets the release time", async () => {
  setupTest();
  const handler = await loadFunction("qualify-session");
  const session = await startListening(200);

  const response = await callFunction(handler, { deviceToken: DEVICE, listenedSeconds: 170, loopCount: 2 });

  assert.equal(response.status, 200);
  const releaseMs = Date.parse(response.body.releaseAt);
  const waitMs = releaseMs - Date.now();
  // SURVEY_DELAY_SECONDS is 60 in the test setup.
  assert.ok(waitMs > 55_000 && waitMs <= 60_000, `release wait was ${waitMs} ms`);

  const saved = sessionById(session.id);
  assert.equal(saved?.status, "queued");
  assert.equal(saved?.loop_count, 2);
  assert.equal(saved?.listened_seconds, 170);
  assert.ok(saved?.qualified_at);
  assert.equal(saved?.release_at, response.body.releaseAt);

  const events = rowsOf("playback_events").filter((event) => event.session_id === session.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].event_type, "sleepy");
});

Deno.test("qualify-session: stops at startup when SURVEY_DELAY_SECONDS is not a number", async () => {
  setupTest({ SURVEY_DELAY_SECONDS: "soon" });

  await assert.rejects(() => loadFunction("qualify-session"), /SURVEY_DELAY_SECONDS/);
});

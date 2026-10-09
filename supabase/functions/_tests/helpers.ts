// Shared test helpers: fake environment, fake Resend, function loader, and seed data.
// All secrets here are fake values for tests only.

import { hash } from "../_shared/http.ts";
import { resetStore, rowsOf, type Row } from "./fake_supabase.ts";

export type Handler = (request: Request) => Response | Promise<Response>;

export const TEST_ENV: Record<string, string> = {
  SUPABASE_URL: "https://fake-project.test",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  CRON_SECRET: "test-cron-secret",
  RESEND_API_KEY: "test-resend-api-key",
  RESEND_FROM: "Resting Notes <study@example.com>",
  APP_URL: "https://app.test/study/",
  ALLOWED_ORIGIN: "https://app.test",
  SURVEY_DELAY_SECONDS: "60",
  DURATION_CONDITION_A: "180",
  DURATION_CONDITION_B: "180",
};

// ---------------------------------------------------------------------------
// Fake Resend. Every POST to api.resend.com/emails is recorded here.
// ---------------------------------------------------------------------------

export type ResendCall = {
  headers: Record<string, string>;
  body: { from: string; to: string[]; subject: string; html: string };
};

export const resendCalls: ResendCall[] = [];

// Set by a test to make the next Resend answers fail. Reset before each test.
export const resendBehaviour = { status: 200, responseText: JSON.stringify({ id: "email_test_1" }) };

let fakeFetchInstalled = false;

function installFakeFetch() {
  if (fakeFetchInstalled) return;
  fakeFetchInstalled = true;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url !== "https://api.resend.com/emails") {
      return Promise.reject(new Error(`Unexpected network call in tests: ${url}`));
    }
    const headers = (init?.headers ?? {}) as Record<string, string>;
    resendCalls.push({ headers, body: JSON.parse(String(init?.body)) });
    return Promise.resolve(new Response(resendBehaviour.responseText, { status: resendBehaviour.status }));
  };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

// Resets the fake database, the fake Resend, and the environment. Call at the start of each test.
export function setupTest(envOverrides: Record<string, string | undefined> = {}) {
  resetStore();
  resendCalls.length = 0;
  resendBehaviour.status = 200;
  resendBehaviour.responseText = JSON.stringify({ id: "email_test_1" });
  installFakeFetch();

  for (const [name, value] of Object.entries({ ...TEST_ENV, ...envOverrides })) {
    if (value === undefined) Deno.env.delete(name);
    else Deno.env.set(name, value);
  }
}

// Each load uses a new URL, so module-level settings (such as SURVEY_DELAY_SECONDS) are read again.
let loadCount = 0;

// The function files call Deno.serve when they load. This captures the handler instead,
// so no server starts during the tests.
export async function loadFunction(name: string): Promise<Handler> {
  let handler: Handler | null = null;
  const originalServe = Deno.serve;
  Object.defineProperty(Deno, "serve", {
    value: (handlerOrOptions: unknown) => {
      handler = handlerOrOptions as Handler;
      return {};
    },
    configurable: true,
    writable: true,
  });
  try {
    loadCount++;
    await import(`${new URL(`../${name}/index.ts`, import.meta.url).href}?load=${loadCount}`);
  } finally {
    Object.defineProperty(Deno, "serve", { value: originalServe, configurable: true, writable: true });
  }
  if (!handler) throw new Error(`${name} did not call Deno.serve`);
  return handler;
}

export async function callFunction(
  handler: Handler,
  body: unknown,
  headers: Record<string, string> = {},
  method = "POST",
) {
  const request = new Request("https://fake-project.test/functions/v1/test", {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await handler(request);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, text };
}

// Captures console.error output while `run` executes. Used to check that emails never appear in logs.
export async function captureErrors<T>(run: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map((part) => String(part)).join(" "));
  };
  try {
    return { result: await run(), lines };
  } finally {
    console.error = original;
  }
}

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

export function isoFromNow(offsetSeconds: number): string {
  return new Date(Date.now() + offsetSeconds * 1000).toISOString();
}

export function seedParticipant(overrides: Row = {}): Row {
  const row: Row = {
    id: crypto.randomUUID(),
    email: "participant@example.com",
    roll_number: null,
    display_name: "Test Participant",
    from_workshop: false,
    auth_user_id: null,
    created_at: isoFromNow(-3600),
    ...overrides,
  };
  rowsOf("participants").push(row);
  return row;
}

// Adds a study session. deviceToken is hashed the same way start-session hashes it.
export async function seedSession(participantId: string, deviceToken: string, overrides: Row = {}): Promise<Row> {
  const row: Row = {
    id: crypto.randomUUID(),
    participant_id: participantId,
    device_token_hash: await hash(deviceToken),
    condition_id: "condition-a",
    duration_seconds: 180,
    status: "listening",
    listened_seconds: 0,
    loop_count: 0,
    qualified_at: null,
    release_at: null,
    email_sent_at: null,
    email_provider_id: null,
    email_attempts: 0,
    resend_count: 0,
    last_resend_at: null,
    sending_started_at: null,
    created_at: isoFromNow(-600),
    ended_at: null,
    ...overrides,
  };
  rowsOf("study_sessions").push(row);
  return row;
}

export function sessionById(id: string): Row | undefined {
  return rowsOf("study_sessions").find((row) => row.id === id);
}

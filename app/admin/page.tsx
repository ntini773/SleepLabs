"use client";

import { FormEvent, useEffect, useState } from "react";

type SessionRow = {
  id: string;
  participantId: string;
  rollNumber: string;
  workshopStatus: string;
  conditionId: string;
  status: string;
  listenedSeconds: number;
  loopCount: number;
  surveyComplete: boolean;
  qualifiedAt: string | null;
  createdAt: string;
};

type AdminScreen = "signin" | "check_email" | "dashboard";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

function formatDuration(seconds: number) {
  if (seconds === 0) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export default function AdminPage() {
  const [screen, setScreen] = useState<AdminScreen>("signin");
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [message, setMessage] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [busy, setBusy] = useState(false);

  // On mount: check for a magic-link access_token in the URL hash.
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    const params = new URLSearchParams(hash);
    const token = params.get("access_token");
    if (token) {
      history.replaceState(null, "", window.location.pathname);
      loadDashboard(token);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadDashboard(token: string) {
    setBusy(true);
    setMessage("Loading…");
    const url = SUPABASE_URL;
    const key = SUPABASE_ANON_KEY;
    if (!url || !key) {
      setMessage("Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.");
      setBusy(false);
      return;
    }
    try {
      const r = await fetch(`${url}/functions/v1/admin-dashboard`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, apikey: key },
      });
      const data = await r.json();
      if (!r.ok) {
        setMessage(data.error ?? "Access denied.");
        setBusy(false);
        return;
      }
      setRows(data.sessions ?? []);
      setMessage("");
      setScreen("dashboard");
    } catch {
      setMessage("Network error. Please refresh.");
    } finally {
      setBusy(false);
    }
  }

  // Request an admin magic link via Supabase Auth OTP (no service-role needed).
  async function requestSignIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!adminEmail) return;
    setBusy(true);
    setMessage("");

    const url = SUPABASE_URL;
    const key = SUPABASE_ANON_KEY;
    if (!url || !key) {
      setMessage("Supabase is not configured.");
      setBusy(false);
      return;
    }

    try {
      // Use Supabase Auth OTP endpoint — only works if the email exists in Auth.
      // shouldCreateUser: false ensures non-admin emails receive no account creation.
      const r = await fetch(`${url}/auth/v1/otp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: key,
        },
        body: JSON.stringify({
          email: adminEmail,
          create_user: false,
          options: {
            // Redirect back to /admin so the hash is consumed by this page.
            email_redirect_to: `${window.location.origin}${window.location.pathname}`,
          },
        }),
      });

      if (r.ok || r.status === 422) {
        // 422 means email not found — we still show the same message to avoid
        // leaking which emails are registered.
        setScreen("check_email");
      } else {
        const data = await r.json().catch(() => ({}));
        setMessage((data as { msg?: string }).msg ?? "Could not send the sign-in link. Please try again.");
      }
    } catch {
      setMessage("Network error. Please check your connection.");
    } finally {
      setBusy(false);
    }
  }

  const notConfigured = !SUPABASE_URL || !SUPABASE_ANON_KEY;

  return (
    <main className="admin-shell">
      {screen === "signin" && (
        <div className="admin-signin">
          <h1>Admin sign-in</h1>
          <p>Enter your administrator email to receive a sign-in link.</p>
          {notConfigured && (
            <p className="error-message">
              ⚠ Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.
            </p>
          )}
          <form onSubmit={requestSignIn}>
            <label>
              Email address
              <input
                autoComplete="email"
                disabled={busy || notConfigured}
                onChange={(e) => setAdminEmail(e.target.value)}
                placeholder="admin@example.com"
                required
                type="email"
                value={adminEmail}
              />
            </label>
            {message && <p className="error-message" role="alert">{message}</p>}
            <button
              className="button primary"
              disabled={busy || !adminEmail || notConfigured}
              type="submit"
            >
              {busy ? "Sending…" : "Send sign-in link"}
            </button>
          </form>
        </div>
      )}

      {screen === "check_email" && (
        <div className="admin-signin">
          <h1>Check your email</h1>
          <p>
            If <strong>{adminEmail}</strong> is registered as an administrator, you will receive a
            sign-in link shortly. Open it on this device to access the dashboard.
          </p>
          <button
            className="text-button"
            onClick={() => { setScreen("signin"); setMessage(""); }}
            type="button"
          >
            ← Try a different email
          </button>
        </div>
      )}

      {screen === "dashboard" && (
        <>
          <h1>Study attempts</h1>
          {message && <p role="alert">{message}</p>}
          {rows.length === 0 ? (
            <p>No sessions recorded yet.</p>
          ) : (
            <div className="admin-table">
              <table>
                <thead>
                  <tr>
                    <th>Participant ID</th>
                    <th>Roll number</th>
                    <th>Workshop</th>
                    <th>Condition</th>
                    <th>Status</th>
                    <th>Listening</th>
                    <th>Loops</th>
                    <th>Survey</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td title={row.participantId}>{row.participantId.slice(0, 8)}</td>
                      <td>{row.rollNumber}</td>
                      <td>{row.workshopStatus === "workshop" ? "Yes" : "No"}</td>
                      <td>{row.conditionId}</td>
                      <td>{row.status}</td>
                      <td>{formatDuration(row.listenedSeconds)}</td>
                      <td>{row.loopCount}</td>
                      <td>{row.surveyComplete ? "✓" : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </main>
  );
}

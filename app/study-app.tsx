"use client";

import { FormEvent, useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Screen =
  | "loading"       // checking localStorage for a returning device token
  | "welcome"       // registration form
  | "listen"        // audio player
  | "waiting"       // post-qualification, pre-email
  | "survey"        // reflection form (after magic link or device return)
  | "complete"      // survey submitted
  | "science"       // optional debrief
  | "already_registered"; // duplicate participant path

type ParticipantState = {
  deviceToken: string;
  conditionId: string;
  durationSeconds: number;
};

type Ratings = Record<"relaxed" | "sleepy" | "alert" | "pleasant", number | null>;

const initialRatings: Ratings = { relaxed: null, sleepy: null, alert: null, pleasant: null };

// ---------------------------------------------------------------------------
// Config — audio files must be uploaded to Supabase Storage.
// Set NEXT_PUBLIC_AUDIO_BASE_URL to the public or signed-URL base path.
// Expected object names: condition-a.mp3 and condition-b.mp3
// ---------------------------------------------------------------------------
const AUDIO_BASE_URL = process.env.NEXT_PUBLIC_AUDIO_BASE_URL ?? "";

// Condition metadata — filenames and loop fractions.
const CONDITION_METADATA: Record<string, { filename: string; loopStartFraction: number }> = {
  "condition-a": { filename: "wholetones.mpeg", loopStartFraction: 27 / 46 },
  "condition-b": { filename: "Nilambari.mpeg", loopStartFraction: 31 / 52 },
};

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

function apiUrl(fn: string) {
  return `${SUPABASE_URL}/functions/v1/${fn}`;
}

function apiHeaders(token?: string): HeadersInit {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    apikey: SUPABASE_ANON_KEY,
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

const DEVICE_TOKEN_KEY = "rn_device_token";

function saveDeviceToken(token: string) {
  try { localStorage.setItem(DEVICE_TOKEN_KEY, token); } catch { /* ignore */ }
}
function loadDeviceToken(): string | null {
  try { return localStorage.getItem(DEVICE_TOKEN_KEY); } catch { return null; }
}
function clearDeviceToken() {
  try { localStorage.removeItem(DEVICE_TOKEN_KEY); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Rating sub-component
// ---------------------------------------------------------------------------

function Rating({
  label,
  value,
  onChange,
  left,
  right,
}: {
  label: string;
  value: number | null;
  onChange: (v: number) => void;
  left: string;
  right: string;
}) {
  return (
    <fieldset className="rating-field">
      <legend>{label}</legend>
      <div className="rating-scale" role="radiogroup" aria-label={label}>
        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
          <button
            aria-checked={value === n}
            className={value === n ? "rating selected" : "rating"}
            key={n}
            onClick={() => onChange(n)}
            role="radio"
            type="button"
          >
            {n}
          </button>
        ))}
      </div>
      <div className="rating-labels" aria-hidden="true">
        <span>{left}</span>
        <span>{right}</span>
      </div>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function StudyApp() {
  const [screen, setScreen] = useState<Screen>("loading");

  // Registration fields
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [rollNumber, setRollNumber] = useState("");
  const [workshop, setWorkshop] = useState<"yes" | "no" | "">("");
  const [consented, setConsented] = useState(false);

  // Session state
  const [participant, setParticipant] = useState<ParticipantState | null>(null);

  // Player state
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const maxListenedSecondsRef = useRef(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [isLooping, setIsLooping] = useState(false);
  const [loopCount, setLoopCount] = useState(0);
  const [audioError, setAudioError] = useState<string | null>(null);

  // Survey state
  const [ratings, setRatings] = useState<Ratings>(initialRatings);
  const [surveyWorkshop, setSurveyWorkshop] = useState("");
  const [headphones, setHeadphones] = useState("");
  const [notes, setNotes] = useState("");
  const [surveyAccessToken, setSurveyAccessToken] = useState<string | null>(null);
  const [surveyParticipantId, setSurveyParticipantId] = useState<string | null>(null);

  // UI state
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Test-only skip button. Shown only in a build with NEXT_PUBLIC_ENABLE_TEST_MODE=1 and ?test=1.
  const [isTestMode, setIsTestMode] = useState(false);

  // Survey release time (qualified_at + SURVEY_DELAY_SECONDS) and the "Resend email" button
  const [releaseAt, setReleaseAt] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [resendBusy, setResendBusy] = useState(false);
  const [resendNotice, setResendNotice] = useState<{ kind: "info" | "error"; text: string } | null>(null);

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search);
    if (process.env.NEXT_PUBLIC_ENABLE_TEST_MODE === "1" && searchParams.get("test") === "1") {
      setIsTestMode(true);
    }
  }, []);

  const allRatingsComplete = Object.values(ratings).every((r) => r !== null) && surveyWorkshop !== "" && headphones !== "";

  const conditionMeta = participant ? CONDITION_METADATA[participant.conditionId] : null;
  const duration = participant?.durationSeconds ?? 0;
  const requiredPoint = Math.ceil(duration * 0.9);
  const loopStartSeconds = conditionMeta ? Math.floor(duration * conditionMeta.loopStartFraction) : 0;
  const listenPercent = duration > 0 ? Math.min((elapsed / duration) * 100, 100) : 0;

  // -------------------------------------------------------------------------
  // On mount: check for magic-link token in URL hash, then check localStorage.
  // -------------------------------------------------------------------------
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    const params = new URLSearchParams(hash);
    const accessToken = params.get("access_token");

    if (accessToken) {
      // Remove token from URL without reloading.
      history.replaceState(null, "", window.location.pathname);
      setSurveyAccessToken(accessToken);
      checkSurveyAccess(accessToken);
      return;
    }

    // Check device token for a returning participant.
    const storedToken = loadDeviceToken();
    if (storedToken && SUPABASE_URL && SUPABASE_ANON_KEY) {
      fetch(apiUrl("study-status"), {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify({ deviceToken: storedToken }),
      })
        .then((r) => r.json())
        .then((data) => {
          if (data.state) {
            const p: ParticipantState = {
              deviceToken: storedToken,
              conditionId: data.conditionId ?? "",
              durationSeconds: data.durationSeconds ?? 0,
            };
            setParticipant(p);
            if (typeof data.releaseAt === "string") setReleaseAt(data.releaseAt);
            if (data.state === "listening") {
              setScreen("listen");
            } else if (data.state === "waiting") {
              setScreen("waiting");
            } else if (data.state === "ready_needs_login") {
              // Show waiting with a note that the email was sent.
              setScreen("waiting");
            } else {
              // complete or unknown — clear token and show welcome.
              clearDeviceToken();
              setScreen("welcome");
            }
          } else {
            clearDeviceToken();
            setScreen("welcome");
          }
        })
        .catch(() => setScreen("welcome"));
    } else {
      setScreen("welcome");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -------------------------------------------------------------------------
  // Survey access check (magic link path)
  // -------------------------------------------------------------------------
  async function checkSurveyAccess(token: string) {
    try {
      const r = await fetch(apiUrl("survey-access"), {
        method: "POST",
        headers: apiHeaders(token),
        body: JSON.stringify({ action: "check" }),
      });
      const data = await r.json();
      if (data.submitted) { setScreen("complete"); return; }
      if (data.available) {
        setSurveyParticipantId(data.participantId ?? null);
        setScreen("survey");
      } else {
        setError(data.error ?? "Your reflection is not available yet.");
        setScreen("waiting");
      }
    } catch {
      setError("Could not check survey availability. Please try again.");
      setScreen("welcome");
    }
  }

  // -------------------------------------------------------------------------
  // Audio element setup — called when entering the listen screen.
  // -------------------------------------------------------------------------
  function setupAudio(conditionId: string, durationSec: number) {
    if (!AUDIO_BASE_URL) {
      setAudioError(
        "Audio is not configured. Set NEXT_PUBLIC_AUDIO_BASE_URL and upload condition-a.mp3 / condition-b.mp3 to Supabase Storage."
      );
      return;
    }

    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
    }

    maxListenedSecondsRef.current = 0;
    const filename = CONDITION_METADATA[conditionId]?.filename ?? `${conditionId}.mpeg`;
    const audio = new Audio();
    audio.crossOrigin = "anonymous";
    audio.src = `${AUDIO_BASE_URL}/${filename}`;
    audio.preload = "auto";
    audioRef.current = audio;

    const loopStart = Math.floor(durationSec * (CONDITION_METADATA[conditionId]?.loopStartFraction ?? 0.6));

    audio.addEventListener("timeupdate", () => {
      const current = Math.floor(audio.currentTime);
      if (current > maxListenedSecondsRef.current) {
        maxListenedSecondsRef.current = current;
      }
      setElapsed(maxListenedSecondsRef.current);

      // Transition to loop phase UI at 90%.
      if (maxListenedSecondsRef.current >= Math.ceil(durationSec * 0.9)) {
        setIsLooping(true);
      }
    });

    audio.addEventListener("play", () => setIsPlaying(true));
    audio.addEventListener("pause", () => setIsPlaying(false));

    // On ended: jump to loopStart and continue playing (without audio.loop)
    audio.addEventListener("ended", () => {
      setLoopCount((c) => c + 1);
      audio.currentTime = loopStart;
      audio.play().catch(() => {});
    });

    audio.addEventListener("error", () => {
      const errDetails = audio.error ? ` [Code ${audio.error.code}: ${audio.error.message}]` : "";
      console.error("Audio load error:", audio.error);
      setAudioError(
        `Could not load audio file (${filename})${errDetails}. URL: ${AUDIO_BASE_URL}/${filename}`
      );
    });
  }

  // Cleanup audio on unmount.
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = "";
      }
    };
  }, []);

  // -------------------------------------------------------------------------
  // Participant start
  // -------------------------------------------------------------------------
  async function beginStudy() {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      setError("Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(apiUrl("start-session"), {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify({ displayName, email, rollNumber, workshop }),
      });
      const data = await r.json();
      if (!r.ok) {
        if (r.status === 409) {
          setResendNotice(null);
          setScreen("already_registered");
          return;
        }
        setError(data.error ?? "Could not start session.");
        return;
      }
      const p: ParticipantState = {
        deviceToken: data.deviceToken,
        conditionId: data.conditionId,
        durationSeconds: data.durationSeconds,
      };
      setParticipant(p);
      saveDeviceToken(data.deviceToken);
      setupAudio(data.conditionId, data.durationSeconds);
      setElapsed(0);
      setLoopCount(0);
      setIsLooping(false);
      setScreen("listen");
    } catch {
      setError("Network error. Please check your connection.");
    } finally {
      setBusy(false);
    }
  }

  function startPlayback() {
    if (!audioRef.current) {
      if (participant) setupAudio(participant.conditionId, participant.durationSeconds);
      return;
    }
    audioRef.current.play().catch(() => {
      setAudioError("Could not start playback. Please tap the button again.");
    });
  }

  // -------------------------------------------------------------------------
  // Qualification ("I'm sleepy")
  // -------------------------------------------------------------------------
  async function stopListening() {
    setBusy(true);
    setError(null);

    const listenedSeconds = maxListenedSecondsRef.current;

    try {
      if (SUPABASE_URL && SUPABASE_ANON_KEY && participant) {
        const r = await fetch(apiUrl("qualify-session"), {
          method: "POST",
          headers: apiHeaders(),
          body: JSON.stringify({
            deviceToken: participant.deviceToken,
            listenedSeconds,
            loopCount, // Only real repeats. The audio never repeated if this is 0.
          }),
        });
        const data = await r.json();
        if (!r.ok) {
          setError(data.error ?? "Could not qualify session.");
          setBusy(false);
          return;
        }
        if (typeof data.releaseAt === "string") setReleaseAt(data.releaseAt);
      }

      // Only pause and clear audio AFTER qualify-session fetch succeeds
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = "";
      }
      setIsPlaying(false);
      setScreen("waiting");
    } catch {
      setError("Network error during qualification. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  // Tick once a second on the waiting screen so the Resend button appears when the wait is over.
  useEffect(() => {
    if (screen !== "waiting" || !releaseAt) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [screen, releaseAt]);

  // -------------------------------------------------------------------------
  // Resend the survey email.
  // "device": waiting screen, identified by the device token.
  // "details": already-registered screen, identified by the email / roll number typed.
  // The server always sends to the email saved at registration, and only after the wait time.
  // -------------------------------------------------------------------------
  async function resendInvitation(mode: "device" | "details") {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      setResendNotice({ kind: "error", text: "Supabase is not configured." });
      return;
    }
    setResendBusy(true);
    setResendNotice(null);
    try {
      const payload =
        mode === "device" && participant
          ? { deviceToken: participant.deviceToken }
          : { email, rollNumber: workshop === "yes" ? rollNumber : "" };
      const r = await fetch(apiUrl("resend-invitation"), {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify(payload),
      });
      const data = await r.json().catch(() => ({}));
      switch (data.status) {
        case "sent":
          setResendNotice({
            kind: "info",
            text: "A fresh link is on its way. It can take a minute, and it may land in spam or junk. Please use the newest email only.",
          });
          break;
        case "submitted":
          setResendNotice({ kind: "info", text: "Your reflection is already complete. Thank you!" });
          break;
        case "too_early": {
          const when = data.availableAt
            ? new Date(data.availableAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })
            : "the release time";
          setResendNotice({ kind: "info", text: `Your reflection email is not due yet. It will be sent after ${when}.` });
          break;
        }
        case "pending":
          setResendNotice({
            kind: "info",
            text: "Your reflection email is being sent right now. Please check your inbox (and spam) and try again in a minute or two if it has not arrived.",
          });
          break;
        case "not_ready":
          setResendNotice({
            kind: "info",
            text: "No reflection email is due yet. It is sent after you finish listening and the release time has passed. If you have not finished listening, return on the device you started with.",
          });
          break;
        case "too_soon": {
          const mins = Math.max(1, Math.ceil((data.retryAfterSeconds ?? 300) / 60));
          setResendNotice({
            kind: "info",
            text: `We sent one a moment ago. Please wait about ${mins} minute${mins === 1 ? "" : "s"} before asking again.`,
          });
          break;
        }
        case "limit":
          setResendNotice({ kind: "error", text: "You have reached the resend limit. Please contact the study team." });
          break;
        default:
          setResendNotice({ kind: "error", text: data.error ?? "Could not resend the email. Please try again in a moment." });
      }
    } catch {
      setResendNotice({ kind: "error", text: "Network error. Please check your connection." });
    } finally {
      setResendBusy(false);
    }
  }

  // -------------------------------------------------------------------------
  // Survey submission
  // -------------------------------------------------------------------------
  async function submitSurvey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!allRatingsComplete) return;
    setBusy(true);
    setError(null);

    try {
      const token = surveyAccessToken;
      if (!token) {
        // Device-return path: no access token; show message to use email link.
        setError("Please use the survey link from your email to submit your reflection.");
        setBusy(false);
        return;
      }

      const r = await fetch(apiUrl("survey-access"), {
        method: "POST",
        headers: apiHeaders(token),
        body: JSON.stringify({
          action: "submit",
          relaxed: ratings.relaxed,
          sleepy: ratings.sleepy,
          alert: ratings.alert,
          pleasant: ratings.pleasant,
          musicWorkshop: surveyWorkshop,
          headphones,
          notes,
        }),
      });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error ?? "Could not submit the survey.");
        return;
      }
      clearDeviceToken();
      setScreen("complete");
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  const canBegin =
    !busy &&
    consented &&
    email !== "" &&
    displayName !== "" &&
    workshop !== "" &&
    (workshop !== "yes" || rollNumber !== "");

  return (
    <main className="app-shell">
      <header className="site-header">
        <a className="wordmark" href="#top" onClick={(e) => e.preventDefault()}>
          <span className="wordmark-mark" aria-hidden="true">∿</span>
          resting notes
        </a>
        <span className="study-label">Listening study · 01</span>
      </header>

      <div className="ambient ambient-one" aria-hidden="true" />
      <div className="ambient ambient-two" aria-hidden="true" />

      {/* Loading */}
      {screen === "loading" && (
        <section className="complete screen">
          <p className="eyebrow">One moment…</p>
        </section>
      )}

      {/* Welcome / registration */}
      {screen === "welcome" && (
        <section className="welcome screen" id="top">
          <p className="eyebrow">A quiet listening study</p>
          <h1>Take a moment to listen.</h1>
          <p className="intro">
            Begin a short listening session this evening. Your reflection will be available the following morning.
          </p>
          <div className="details-card">
            <div><span>01</span><p>Choose a calm place and use headphones if available.</p></div>
            <div><span>02</span><p>Listen until the audio begins repeating, then stop whenever you feel ready.</p></div>
            <div><span>03</span><p>When the audio repeats, tell us if you feel sleepy.</p></div>
          </div>
          <div className="details-form">
            <label>
              Full name{" "}
              <input
                autoComplete="name"
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Your full name"
                required
                value={displayName}
              />
            </label>
            <fieldset className="workshop-choice">
              <legend>Are you from a music workshop?</legend>
              <div>
                <button
                  aria-pressed={workshop === "yes"}
                  className={workshop === "yes" ? "choice selected" : "choice"}
                  onClick={() => setWorkshop("yes")}
                  type="button"
                >
                  Yes
                </button>
                <button
                  aria-pressed={workshop === "no"}
                  className={workshop === "no" ? "choice selected" : "choice"}
                  onClick={() => setWorkshop("no")}
                  type="button"
                >
                  No
                </button>
              </div>
            </fieldset>
            <div className={workshop ? "email-card flipped" : "email-card"}>
              <div className="email-card-face">
                {workshop === "yes" && (
                  <label>
                    Roll number{" "}
                    <input
                      onChange={(e) => setRollNumber(e.target.value)}
                      placeholder="e.g. 24MUS001"
                      required
                      value={rollNumber}
                    />
                  </label>
                )}
                <label>
                  {workshop === "yes" ? "College email" : "Email address"}
                  <input
                    autoComplete="email"
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder={workshop === "yes" ? "you@college.edu" : "you@example.com"}
                    required
                    type="email"
                    value={email}
                  />
                </label>
              </div>
            </div>
          </div>
          <label className="consent">
            <input
              checked={consented}
              onChange={(e) => setConsented(e.target.checked)}
              type="checkbox"
            />
            <span>I understand that I may stop and leave the study at any time.</span>
          </label>
          {error && <p className="error-message" role="alert">{error}</p>}
          <button
            className="button primary"
            disabled={!canBegin}
            onClick={beginStudy}
            type="button"
          >
            {busy ? "Starting…" : <>Begin listening <span aria-hidden="true">→</span></>}
          </button>
          {(!SUPABASE_URL || !SUPABASE_ANON_KEY) && (
            <p className="microcopy config-warning">
              ⚠ Supabase is not configured — set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.
            </p>
          )}
        </section>
      )}

      {/* Already registered */}
      {screen === "already_registered" && (
        <section className="complete screen">
          <div className="completion-icon" aria-hidden="true">↩</div>
          <p className="eyebrow">Already registered</p>
          <h1>Welcome back.</h1>
          <p className="intro">
            A session already exists for these details. Return on the same device you used to start,
            or use the secure link in your invitation email.
          </p>
          <button className="button primary" disabled={resendBusy} onClick={() => resendInvitation("details")} type="button">
            {resendBusy ? "Sending…" : "Didn't get the email? Resend it"}
          </button>
          {resendNotice && (
            <p className={resendNotice.kind === "error" ? "error-message" : "microcopy"} role="status">
              {resendNotice.text}
            </p>
          )}
          <p className="microcopy">The link goes to the email address you registered with.</p>
        </section>
      )}

      {/* Listen */}
      {screen === "listen" && (
        <section className="player-screen screen" aria-live="polite">
          <div className="session-meta">
            <span>Session in progress</span>
            <span>{isLooping ? "Loop phase" : "Listening phase"}</span>
          </div>
          <div className={isPlaying ? "orb playing" : "orb"} aria-hidden="true">
            <i /><i /><i /><i /><i />
          </div>
          <p className="eyebrow">Listening session</p>
          <h1>{isLooping ? "The audio is repeating." : "Make space for the sound."}</h1>
          <p className="player-copy">
            {isLooping
              ? "When you are ready, stop the session to continue to the reflection."
              : "This listening phase has no pause control. Keep this page open while you listen."}
          </p>
          {audioError ? (
            <p className="error-message config-warning" role="alert">{audioError}</p>
          ) : (
            <>
              <div
                className="timeline"
                aria-label={`Listening progress: ${Math.round(listenPercent)} percent`}
              >
                <div className="timeline-fill" style={{ width: `${listenPercent}%` }} />
                <span className="timeline-thumb" style={{ left: `${listenPercent}%` }} />
              </div>
              <div className="time-row">
                <span>{formatTime(elapsed)}</span>
                <span>{isLooping ? `Loop ${loopCount}` : `Listening · ${formatTime(requiredPoint)} minimum`}</span>
                <span>{formatTime(duration)}</span>
              </div>
            </>
          )}
          <div className="player-actions">
            {!isPlaying && !isLooping && (
              <button className="play-button" onClick={startPlayback} type="button">
                <span aria-hidden="true">▶</span>Start listening
              </button>
            )}
            {isPlaying && !isLooping && (
              <span className="listening-indicator">Listening in progress</span>
            )}
            {isLooping && (
              <button
                className="button primary sleepy-button"
                disabled={busy}
                onClick={stopListening}
                type="button"
              >
                {busy ? "Saving…" : <>I&apos;m sleepy <span aria-hidden="true">→</span></>}
              </button>
            )}
            {process.env.NEXT_PUBLIC_ENABLE_TEST_MODE === "1" && isTestMode && !isLooping && (
              <button
                className="text-button admin-skip-button"
                onClick={() => {
                  maxListenedSecondsRef.current = requiredPoint;
                  setElapsed(requiredPoint);
                  setIsLooping(true);
                  if (audioRef.current) {
                    try {
                      audioRef.current.currentTime = requiredPoint;
                    } catch { /* ignore */ }
                  }
                }}
                style={{ marginTop: "1rem", fontSize: "0.825rem", opacity: 0.75, cursor: "pointer" }}
                type="button"
              >
                ⚡ Admin: Skip mandatory listening phase
              </button>
            )}
          </div>
          {error && <p className="error-message" role="alert">{error}</p>}
        </section>
      )}

      {/* Waiting */}
      {screen === "waiting" && (
        <section className="complete screen">
          <div className="completion-icon" aria-hidden="true">☾</div>
          <p className="eyebrow">Listening complete</p>
          <h1>Rest well tonight.</h1>
          <p className="intro">
            Your reflection will unlock shortly. Return on this device after signing in, or use the
            secure link you receive by email.
          </p>
          {participant?.deviceToken && releaseAt && (
            now >= Date.parse(releaseAt) ? (
              <>
                <button className="button primary" disabled={resendBusy} onClick={() => resendInvitation("device")} type="button">
                  {resendBusy ? "Sending…" : "Didn't get the email? Resend it"}
                </button>
                {resendNotice && (
                  <p className={resendNotice.kind === "error" ? "error-message" : "microcopy"} role="status">
                    {resendNotice.text}
                  </p>
                )}
              </>
            ) : (
              <p className="microcopy">
                If your email has not arrived, you can ask for a new one after{" "}
                {new Date(releaseAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}.
              </p>
            )
          )}
          {error && <p className="error-message" role="alert">{error}</p>}
        </section>
      )}

      {/* Survey */}
      {screen === "survey" && (
        <section className="survey screen">
          <div className="survey-heading">
            <p className="eyebrow">Reflection</p>
            <h1>How do you feel now?</h1>
            <p>Choose the number that feels most accurate in this moment.</p>
          </div>
          <form onSubmit={submitSurvey}>
            <div className="form-card">
              <Rating
                label="How relaxed do you feel?"
                left="Not relaxed"
                right="Very relaxed"
                value={ratings.relaxed}
                onChange={(v) => setRatings((s) => ({ ...s, relaxed: v }))}
              />
              <Rating
                label="How sleepy do you feel?"
                left="Not sleepy"
                right="Very sleepy"
                value={ratings.sleepy}
                onChange={(v) => setRatings((s) => ({ ...s, sleepy: v }))}
              />
              <Rating
                label="How alert do you feel?"
                left="Not alert"
                right="Very alert"
                value={ratings.alert}
                onChange={(v) => setRatings((s) => ({ ...s, alert: v }))}
              />
              <Rating
                label="How pleasant was the audio?"
                left="Not pleasant"
                right="Very pleasant"
                value={ratings.pleasant}
                onChange={(v) => setRatings((s) => ({ ...s, pleasant: v }))}
              />
            </div>
            <div className="form-card background-card">
              <h2>A little about you</h2>
              <label>
                Are you part of a music workshop?
                <select
                  value={surveyWorkshop}
                  onChange={(e) => setSurveyWorkshop(e.target.value)}
                  required
                >
                  <option value="" disabled>Select one</option>
                  <option value="yes_currently">Yes, currently</option>
                  <option value="previously">Previously</option>
                  <option value="no">No</option>
                  <option value="prefer_not">Prefer not to say</option>
                </select>
              </label>
              <label>
                Were you using headphones?
                <select
                  value={headphones}
                  onChange={(e) => setHeadphones(e.target.value)}
                  required
                >
                  <option value="" disabled>Select one</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              </label>
              <label>
                Anything you noticed while listening?
                <textarea
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Optional"
                  rows={3}
                  value={notes}
                />
              </label>
            </div>
            {error && <p className="error-message" role="alert">{error}</p>}
            <button
              className="button primary"
              disabled={!allRatingsComplete || busy}
              type="submit"
            >
              {busy ? "Submitting…" : <>Complete reflection <span aria-hidden="true">→</span></>}
            </button>
          </form>
          {/* Suppress unused variable warning — participantId available if needed */}
          {surveyParticipantId && <span style={{ display: "none" }} aria-hidden="true" />}
        </section>
      )}

      {/* Complete */}
      {screen === "complete" && (
        <section className="complete screen">
          <div className="completion-icon" aria-hidden="true">✓</div>
          <p className="eyebrow">Session complete</p>
          <h1>Thank you for listening.</h1>
          <p className="intro">
            Your reflection helps us understand how different musical experiences may shape moments of rest.
          </p>
          <button
            className="text-button science-link"
            onClick={() => setScreen("science")}
            type="button"
          >
            Curious about the science? <span aria-hidden="true">→</span>
          </button>
        </section>
      )}

      {/* Science debrief */}
      {screen === "science" && (
        <section className="science screen">
          <button className="back" onClick={() => setScreen("complete")} type="button">
            ← Back
          </button>
          <p className="eyebrow">About the study</p>
          <h1>Why listen to music this way?</h1>
          <div className="science-copy">
            <p>
              Sound can shape attention, breathing, and the way we notice our internal state. This study
              compares reflections after different listening sessions.
            </p>
            <p>
              There is no expected response. Your honest experience—including stopping quickly—is useful
              information.
            </p>
            <p className="microcopy">
              Note: browser playback telemetry (time elapsed, loop count) raises confidence that the session
              occurred but cannot prove that a person was actively listening. It is treated as supportive
              evidence, not proof.
            </p>
          </div>
        </section>
      )}
    </main>
  );
}

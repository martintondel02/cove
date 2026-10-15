"use client";

/**
 * Uploading a video.
 *
 * This is the one page that has to do real work in the browser, and it is
 * deliberately plain: pick a file, give it a title, watch the progress bar. The
 * polish belongs in Phase 2's admin, once there are passkeys so a token field is not
 * needed at all.
 *
 * The token is stored in `localStorage` and sent as a bearer header on both the
 * upload and the create-post call. That is a stopgap measure and is labelled as one
 * on screen: an admin token pasted into a browser is not where this ends up.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@cove/ui";

type Phase = "idle" | "uploading" | "creating" | "done" | "failed";

interface CreatedPost {
  readonly slug: string;
  readonly url: string;
}

const TOKEN_KEY = "cove_admin_token";

export default function UploadPage() {
  const [token, setToken] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [isReel, setIsReel] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedPost | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  // Remember the token so a second upload does not mean pasting it again. This is a
  // convenience, not security: it lives in the browser either way.
  useEffect(() => {
    setToken(window.localStorage.getItem(TOKEN_KEY) ?? "");
  }, []);

  const onFile = useCallback((chosen: File | null) => {
    setFile(chosen);
    setCreated(null);
    setMessage(null);
    setPhase("idle");
    setProgress(0);
    if (chosen && title.trim().length === 0) {
      // A sensible default title saves a pointless keystroke.
      setTitle(chosen.name.replace(/\.[A-Za-z0-9]{1,8}$/, "").slice(0, 200));
    }
  }, [title]);

  const start = useCallback(async () => {
    if (!file) {
      setMessage("Choose a video file first.");
      return;
    }
    if (token.trim().length < 16) {
      setMessage("Paste your publishing token first (at least 16 characters).");
      return;
    }
    if (title.trim().length === 0) {
      setMessage("Give the video a title.");
      return;
    }

    window.localStorage.setItem(TOKEN_KEY, token.trim());
    const headers = { authorization: `Bearer ${token.trim()}` };
    setPhase("uploading");
    setMessage(null);
    setProgress(0);

    try {
      // Imported lazily so the library never runs during server rendering.
      const tus = await import("tus-js-client");

      const uploadId = await new Promise<string>((resolve, reject) => {
        const upload = new tus.Upload(file, {
          endpoint: "/api/uploads",
          headers,
          chunkSize: 16 * 1024 * 1024,
          retryDelays: [0, 1000, 3000, 5000, 10000],
          metadata: { filename: file.name, filetype: file.type },
          onError: (error) => reject(error),
          onProgress: (sent, total) => {
            setProgress(total > 0 ? Math.round((sent / total) * 100) : 0);
          },
          onSuccess: () => {
            // The Location header ends in the upload id.
            const location = upload.url ?? "";
            const id = location.split("/").filter(Boolean).pop() ?? "";
            id.length > 0 ? resolve(id) : reject(new Error("The upload returned no id."));
          },
        });
        upload.start();
      });

      setPhase("creating");
      const response = await fetch("/api/posts", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || undefined,
          uploadId,
          filename: file.name,
          isReel,
        }),
      });

      const payload = (await response.json()) as {
        post?: CreatedPost;
        error?: string;
        hint?: string;
      };

      if (!response.ok || !payload.post) {
        throw new Error([payload.error, payload.hint].filter(Boolean).join(" — "));
      }

      setCreated(payload.post);
      setPhase("done");
      setMessage("Uploaded. Processing happens in the background.");
    } catch (error) {
      setPhase("failed");
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, [description, file, isReel, title, token]);

  return (
    <main className="cove-shell">
      <section className="cove-section" style={{ marginTop: "28px" }}>
        <div className="cove-section-head">
          <h2>Upload a video</h2>
          <p>Resumable — a dropped connection picks up where it left off</p>
        </div>

        <div className="cove-panel">
          <div style={{ display: "grid", gap: "14px", maxWidth: "640px" }}>
            <label style={{ display: "grid", gap: "6px" }}>
              <span style={{ fontSize: "12.5px", color: "var(--text-muted)" }}>
                Publishing token
              </span>
              <input
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder="COVE_ADMIN_TOKEN from your .env"
                autoComplete="off"
                style={inputStyle}
              />
              <span style={{ fontSize: "11.5px", color: "var(--text-faint)" }}>
                A stopgap until Phase 2 replaces this with a passkey. Stored only in
                this browser.
              </span>
            </label>

            <label style={{ display: "grid", gap: "6px" }}>
              <span style={{ fontSize: "12.5px", color: "var(--text-muted)" }}>Video file</span>
              <input
                ref={fileInput}
                type="file"
                accept="video/*"
                onChange={(event) => onFile(event.target.files?.[0] ?? null)}
                style={{ ...inputStyle, padding: "10px" }}
              />
            </label>

            <label style={{ display: "grid", gap: "6px" }}>
              <span style={{ fontSize: "12.5px", color: "var(--text-muted)" }}>Title</span>
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="A walk along the north coast"
                style={inputStyle}
              />
            </label>

            <label style={{ display: "grid", gap: "6px" }}>
              <span style={{ fontSize: "12.5px", color: "var(--text-muted)" }}>
                Description (optional)
              </span>
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={3}
                style={{ ...inputStyle, resize: "vertical" }}
              />
            </label>

            <label style={{ display: "flex", gap: "9px", alignItems: "center" }}>
              <input
                type="checkbox"
                checked={isReel}
                onChange={(event) => setIsReel(event.target.checked)}
              />
              <span style={{ fontSize: "13px", color: "var(--text-muted)" }}>
                Vertical short (uses the 9:16 ladder)
              </span>
            </label>

            <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
              <Button
                variant="primary"
                onClick={() => void start()}
                disabled={phase === "uploading" || phase === "creating"}
              >
                {phase === "uploading"
                  ? `Uploading… ${progress}%`
                  : phase === "creating"
                    ? "Processing…"
                    : "Upload"}
              </Button>
              {file ? (
                <span style={{ fontSize: "12.5px", color: "var(--text-faint)" }}>
                  {(file.size / 1_048_576).toFixed(1)} MB
                </span>
              ) : null}
            </div>

            {phase === "uploading" || phase === "creating" ? (
              <div
                style={{
                  height: "4px",
                  background: "var(--surface-2)",
                  borderRadius: "4px",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${phase === "creating" ? 100 : progress}%`,
                    height: "100%",
                    background: "var(--accent)",
                    transition: "width var(--dur-1) var(--ease)",
                  }}
                />
              </div>
            ) : null}

            {message ? (
              <p
                style={{
                  margin: 0,
                  fontSize: "13px",
                  color: phase === "failed" ? "var(--live)" : "var(--text-muted)",
                }}
              >
                {message}
              </p>
            ) : null}

            {created ? (
              <p style={{ margin: 0 }}>
                <a className="cove-mono-link" href={created.url}>
                  → watch it at {created.url}
                </a>
              </p>
            ) : null}
          </div>
        </div>
      </section>
    </main>
  );
}

const inputStyle: React.CSSProperties = {
  background: "var(--canvas)",
  border: "1px solid var(--hairline)",
  borderRadius: "var(--r-sm)",
  color: "var(--text)",
  padding: "10px 12px",
  fontSize: "14px",
  fontFamily: "inherit",
  width: "100%",
};

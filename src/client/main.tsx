import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

interface HealthState {
  ok: boolean;
  checkedAt: string;
  error?: string;
}

const checks = [
  { label: "Runtime", value: "Cloudflare Workers", detail: "Hono API routes" },
  { label: "State", value: "Durable Object SQLite", detail: "Memory, sessions, approvals" },
  { label: "Channel", value: "Telegram primary", detail: "Protected test channel enabled" },
  { label: "Model", value: "OpenAI-compatible", detail: "Vercel AI SDK adapter" },
  { label: "Tools", value: "Registry controlled", detail: "Approval-gated HTTP tools" },
];

const boundaries = [
  {
    label: "Persisted",
    value: "Chat sessions, chat messages, curated memory, short-lived approvals, tasks, and non-secret LLM profile metadata.",
  },
  {
    label: "Process memory",
    value: "Active runs, approval continuations, paused approval sessions, and queued follow-up messages.",
  },
  {
    label: "Protected",
    value: "Telegram uses webhook secret and chat allowlist. Admin APIs use bearer token or signed cookie auth.",
  },
  {
    label: "Excluded",
    value: "No web chat UI is exposed. LLM credentials stay in Worker secrets or environment variables.",
  },
];

function App() {
  const [health, setHealth] = useState<HealthState>({
    ok: false,
    checkedAt: "checking",
  });

  useEffect(() => {
    fetch("/api/health")
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = (await response.json()) as { ok?: unknown };
        setHealth({
          ok: body.ok === true,
          checkedAt: new Date().toLocaleString(),
        });
      })
      .catch((error) => {
        setHealth({
          ok: false,
          checkedAt: new Date().toLocaleString(),
          error: error instanceof Error ? error.message : "Health check failed",
        });
      });
  }, []);

  const healthState = health.checkedAt === "checking" ? "pending" : health.ok ? "ok" : "error";
  const healthLabel = healthState === "pending" ? "checking" : health.ok ? "online" : "attention";

  return (
    <main className="status-shell">
      <section className="status-header">
        <div>
          <p className="eyebrow">Status page</p>
          <h1>Agent Worker</h1>
          <p className="lede">Telegram-first personal agent runtime and data boundary overview.</p>
        </div>
        <span className={`status-pill ${healthState}`}>
          <span className="status-dot" />
          {healthLabel}
        </span>
      </section>

      <section className="health-strip" aria-label="Health">
        <div>
          <span>API</span>
          <strong>{health.ok ? "/api/health OK" : health.error ?? "checking"}</strong>
        </div>
        <div>
          <span>Checked</span>
          <strong>{health.checkedAt}</strong>
        </div>
        <div>
          <span>Webhook</span>
          <strong>/api/tg/webhook</strong>
        </div>
      </section>

      <section className="status-grid">
        <article className="status-panel">
          <h2>Runtime Stack</h2>
          <div className="stack-list">
            {checks.map((check) => (
              <div className="stack-row" key={check.label}>
                <span>{check.label}</span>
                <div>
                  <strong>{check.value}</strong>
                  <small>{check.detail}</small>
                </div>
              </div>
            ))}
          </div>
        </article>

        <article className="status-panel">
          <h2>Data Boundary</h2>
          <div className="boundary-list">
            {boundaries.map((item) => (
              <section key={item.label}>
                <h3>{item.label}</h3>
                <p>{item.value}</p>
              </section>
            ))}
          </div>
        </article>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);

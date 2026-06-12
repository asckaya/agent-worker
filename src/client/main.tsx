import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

interface HealthState {
  ok: boolean;
  checkedAt: string;
  error?: string;
}

const checks = [
  { label: "Worker", value: "Cloudflare Workers" },
  { label: "State", value: "DO SQLite bounded memory + in-memory run control" },
  { label: "Channel", value: "Telegram + protected HTTP test channel" },
  { label: "Model", value: "Vercel AI SDK + OpenAI-compatible adapter" },
  { label: "Tools", value: "zod registry + approval-aware executor + guardrails" },
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

  return (
    <main className="status-shell">
      <section className="status-header">
        <div>
          <h1>Agent Worker</h1>
          <p>Runtime status for the Telegram-first personal agent.</p>
        </div>
        <span className={health.ok ? "status-pill ok" : "status-pill error"}>
          {health.ok ? "online" : "check failed"}
        </span>
      </section>

      <section className="status-grid">
        <article className="status-panel">
          <h2>Health</h2>
          <dl>
            <div>
              <dt>API</dt>
              <dd>{health.ok ? "/api/health OK" : health.error ?? "checking"}</dd>
            </div>
            <div>
              <dt>Checked</dt>
              <dd>{health.checkedAt}</dd>
            </div>
            <div>
              <dt>Telegram webhook</dt>
              <dd>/api/tg/webhook</dd>
            </div>
          </dl>
        </article>

        <article className="status-panel">
          <h2>Architecture</h2>
          <dl>
            {checks.map((check) => (
              <div key={check.label}>
                <dt>{check.label}</dt>
                <dd>{check.value}</dd>
              </div>
            ))}
          </dl>
        </article>

        <article className="status-panel wide">
          <h2>Data Boundary</h2>
          <ul>
            <li>No web chat UI is exposed.</li>
            <li>Telegram messages are not stored as conversation history.</li>
            <li>Durable Object SQLite persists bounded memory and short-lived approvals only.</li>
            <li>Active runs, approval continuations, paused approvals, and queued follow-ups are process-memory state.</li>
            <li>LLM credentials for Telegram are Worker secrets/env vars.</li>
            <li>Admin APIs remain protected by signed cookie auth.</li>
          </ul>
        </article>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);

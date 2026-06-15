import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

interface HealthState {
  ok: boolean;
  checkedAt: string;
  error?: string;
}

interface AuthState {
  checked: boolean;
  authenticated: boolean;
  error?: string;
}

interface SkillSummary {
  name: string;
  description?: string;
  sourcePath?: string;
  metadata?: { internal?: boolean };
  files?: Array<{ path: string }>;
}

const checks = [
  { label: "Runtime", value: "Cloudflare Workers", detail: "Hono API routes" },
  { label: "State", value: "Durable Object SQLite", detail: "Memory, sessions, approvals" },
  { label: "Channel", value: "Telegram primary", detail: "Protected test channel enabled" },
  { label: "Model", value: "OpenAI-compatible", detail: "Vercel AI SDK adapter" },
  { label: "Tools", value: "Registry controlled", detail: "Skills and approval-gated MCP tools" },
];

const boundaries = [
  {
    label: "Persisted",
    value: "Chat sessions, chat messages, curated memory, short-lived approvals, tasks, LLM profile metadata, skills, and MCP server settings.",
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
  const [auth, setAuth] = useState<AuthState>({ checked: false, authenticated: false });
  const [token, setToken] = useState("");
  const [skillMarkdown, setSkillMarkdown] = useState(DEFAULT_SKILL_TEMPLATE);
  const [skillSource, setSkillSource] = useState("vercel-labs/agent-skills");
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [mcpText, setMcpText] = useState('{\n  "servers": {}\n}');
  const [configStatus, setConfigStatus] = useState("Not loaded");

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

  useEffect(() => {
    fetch("/api/auth/me", { credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = (await response.json()) as { authenticated?: boolean };
        setAuth({ checked: true, authenticated: body.authenticated === true });
        if (body.authenticated === true) void loadConfig();
      })
      .catch((error) => {
        setAuth({
          checked: true,
          authenticated: false,
          error: error instanceof Error ? error.message : "Auth check failed",
        });
      });
  }, []);

  const healthState = health.checkedAt === "checking" ? "pending" : health.ok ? "ok" : "error";
  const healthLabel = healthState === "pending" ? "checking" : health.ok ? "online" : "attention";

  async function login(event: React.FormEvent) {
    event.preventDefault();
    setConfigStatus("Signing in...");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      setAuth({ checked: true, authenticated: true });
      setToken("");
      await loadConfig();
    } catch (error) {
      setConfigStatus(error instanceof Error ? error.message : "Login failed");
    }
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
    setAuth({ checked: true, authenticated: false });
    setConfigStatus("Signed out");
  }

  async function loadConfig() {
    setConfigStatus("Loading...");
    try {
      const [skills, mcp] = await Promise.all([
        fetchJson<{ settings?: { skills?: SkillSummary[] } }>("/api/agent/settings/skills"),
        fetchJson<{ settings: unknown }>("/api/agent/settings/mcp"),
      ]);
      setSkills(skills.settings?.skills ?? []);
      setMcpText(JSON.stringify(mcp.settings ?? { servers: {} }, null, 2));
      setConfigStatus("Loaded");
    } catch (error) {
      setConfigStatus(error instanceof Error ? error.message : "Load failed");
    }
  }

  async function saveConfig(path: string, text: string) {
    setConfigStatus("Saving...");
    try {
      const payload = JSON.parse(text) as unknown;
      await fetchJson(path, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setConfigStatus("Saved");
      await loadConfig();
    } catch (error) {
      setConfigStatus(error instanceof Error ? error.message : "Save failed");
    }
  }

  async function importSkill() {
    setConfigStatus("Importing skill...");
    try {
      const response = await fetchJson<{ settings?: { skills?: SkillSummary[] } }>(
        "/api/agent/settings/skills/import",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ markdown: skillMarkdown }),
        },
      );
      setSkills(response.settings?.skills ?? []);
      setConfigStatus("Skill imported");
    } catch (error) {
      setConfigStatus(error instanceof Error ? error.message : "Import failed");
    }
  }

  async function importSkillSource() {
    setConfigStatus("Importing skill source...");
    try {
      const response = await fetchJson<{ settings?: { skills?: SkillSummary[] } }>(
        "/api/agent/settings/skills/source",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: skillSource }),
        },
      );
      setSkills(response.settings?.skills ?? []);
      setConfigStatus("Skill source imported");
    } catch (error) {
      setConfigStatus(error instanceof Error ? error.message : "Source import failed");
    }
  }

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

      <section className="admin-panel">
        <div className="admin-heading">
          <div>
            <h2>Runtime Config</h2>
            <p>{auth.authenticated ? configStatus : auth.error ?? "Admin token required"}</p>
          </div>
          {auth.authenticated ? (
            <div className="button-row">
              <button type="button" onClick={() => void loadConfig()}>
                Reload
              </button>
              <button type="button" onClick={() => void logout()}>
                Logout
              </button>
            </div>
          ) : null}
        </div>

        {!auth.authenticated ? (
          <form className="login-form" onSubmit={(event) => void login(event)}>
            <label>
              <span>Admin token</span>
              <input
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                disabled={!auth.checked}
              />
            </label>
            <button type="submit" disabled={!auth.checked || token.trim().length === 0}>
              Login
            </button>
          </form>
        ) : (
          <div className="config-grid">
            <article className="config-editor">
              <header>
                <h3>Skills</h3>
                <div className="button-row">
                  <button type="button" onClick={() => void importSkillSource()}>
                    Import Source
                  </button>
                  <button type="button" onClick={() => void importSkill()}>
                    Import Markdown
                  </button>
                </div>
              </header>
              <label className="source-field">
                <span>Source</span>
                <input
                  value={skillSource}
                  onChange={(event) => setSkillSource(event.target.value)}
                  placeholder="owner/repo, owner/repo/path, owner/repo@skill, or GitHub tree URL"
                />
              </label>
              <textarea
                spellCheck={false}
                value={skillMarkdown}
                onChange={(event) => setSkillMarkdown(event.target.value)}
              />
              <div className="skill-list">
                {skills.length === 0 ? (
                  <p>No skills installed.</p>
                ) : (
                  skills.map((skill) => (
                    <section key={skill.name}>
                      <strong>{skill.name}</strong>
                      <span>{skill.description ?? "No description"}</span>
                      {skill.files?.length ? <small>{skill.files.length} files</small> : null}
                      {skill.metadata?.internal ? <small>internal</small> : null}
                    </section>
                  ))
                )}
              </div>
            </article>

            <article className="config-editor">
              <header>
                <h3>MCP Servers</h3>
                <button
                  type="button"
                  onClick={() => void saveConfig("/api/agent/settings/mcp", mcpText)}
                >
                  Save
                </button>
              </header>
              <textarea
                spellCheck={false}
                value={mcpText}
                onChange={(event) => setMcpText(event.target.value)}
              />
            </article>
          </div>
        )}
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", ...init });
  if (!response.ok) throw new Error(await responseError(response));
  return (await response.json()) as T;
}

async function responseError(response: Response) {
  const body = (await response.json().catch(() => undefined)) as { error?: unknown } | undefined;
  return typeof body?.error === "string" ? body.error : `HTTP ${response.status}`;
}

const DEFAULT_SKILL_TEMPLATE = `---
name: my-skill
description: What this skill does and when to use it
---

# My Skill

Instructions for the agent to follow when this skill is activated.

## When to Use

Describe the scenarios where this skill should be used.

## Steps

1. First, do this
2. Then, do that
`;

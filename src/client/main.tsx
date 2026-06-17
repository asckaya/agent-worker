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

interface SkillSettings {
  sources?: string[];
  skills?: SkillSummary[];
}

interface McpStatusServer {
  name: string;
  url: string;
  status: "connected" | "disabled" | "failed" | "needs_auth";
  cached?: boolean;
  transport?: string;
  error?: string;
  headerNames?: string[];
  oauth?: {
    enabled: boolean;
    authorized: boolean;
    authorizationUrl?: string;
    updatedAt?: number;
  };
  listChanged?: {
    tools?: boolean;
    prompts?: boolean;
    resources?: boolean;
  };
  toolCount?: number;
  promptCount?: number;
  resourceCount?: number;
  tools?: Array<{ name?: string; description?: string }>;
  prompts?: Array<{ name?: string; description?: string }>;
  resources?: Array<{ name?: string; uri?: string; description?: string; mimeType?: string }>;
}

interface RuntimeSettingsResponse {
  settings?: {
    skills?: SkillSettings;
    mcp?: unknown;
    permissions?: unknown;
  };
}

interface McpStatusResponse {
  servers?: McpStatusServer[];
}

interface ActivityEvent {
  id: string;
  type: string;
  channel?: string;
  chatId?: string;
  sessionId?: string;
  summary: string;
  data?: unknown;
  created_at: number;
}

interface ToolOutputSummary {
  id: string;
  channel: string;
  chatId: string;
  sessionId?: string;
  toolCallId: string;
  toolName: string;
  size: number;
  outputUrl: string;
  created_at: number;
  expires_at: number;
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
  const [skillSources, setSkillSources] = useState<string[]>(["vercel-labs/agent-skills"]);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [mcpText, setMcpText] = useState('{\n  "servers": {}\n}');
  const [mcpStatus, setMcpStatus] = useState<McpStatusServer[]>([]);
  const [oauthLinks, setOauthLinks] = useState<Record<string, string>>({});
  const [permissionText, setPermissionText] = useState('{\n  "rules": []\n}');
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [toolOutputs, setToolOutputs] = useState<ToolOutputSummary[]>([]);
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
      const [runtime, mcp, activityResponse, outputResponse] = await Promise.all([
        fetchJson<RuntimeSettingsResponse>("/api/agent/settings/runtime"),
        fetchJson<McpStatusResponse>("/api/agent/settings/mcp/status").catch(() => ({ servers: [] })),
        fetchJson<{ events?: ActivityEvent[] }>("/api/agent/activity?limit=20").catch(() => ({ events: [] })),
        fetchJson<{ outputs?: ToolOutputSummary[] }>("/api/agent/tool-outputs?limit=20").catch(() => ({ outputs: [] })),
      ]);
      const skillSettings = runtime.settings?.skills ?? {};
      setSkills(skillSettings.skills ?? []);
      setSkillSources(normalizeSkillSources(skillSettings.sources ?? []).length
        ? normalizeSkillSources(skillSettings.sources ?? [])
        : [""]);
      setMcpText(JSON.stringify(runtime.settings?.mcp ?? { servers: {} }, null, 2));
      setPermissionText(JSON.stringify(runtime.settings?.permissions ?? { rules: [] }, null, 2));
      setMcpStatus(mcp.servers ?? []);
      setActivity(activityResponse.events ?? []);
      setToolOutputs(outputResponse.outputs ?? []);
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

  async function importSkillSource() {
    const sources = normalizeSkillSources(skillSources);
    if (sources.length === 0) {
      setConfigStatus("Add at least one skill source");
      return;
    }

    setConfigStatus(`Importing ${sources.length} skill source${sources.length === 1 ? "" : "s"}...`);
    try {
      const response = await fetchJson<{ settings?: SkillSettings }>(
        "/api/agent/settings/skills/source",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sources }),
        },
      );
      setSkills(response.settings?.skills ?? []);
      setSkillSources(response.settings?.sources?.length ? response.settings.sources : sources);
      setConfigStatus("Skill sources imported");
    } catch (error) {
      setConfigStatus(error instanceof Error ? error.message : "Source import failed");
    }
  }

  async function saveSkillSources() {
    const sources = normalizeSkillSources(skillSources);
    setConfigStatus("Saving skill sources...");
    try {
      const response = await fetchJson<{ settings?: SkillSettings }>(
        "/api/agent/settings/skills/sources",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sources }),
        },
      );
      setSkillSources(response.settings?.sources?.length ? response.settings.sources : [""]);
      setConfigStatus("Skill sources saved");
    } catch (error) {
      setConfigStatus(error instanceof Error ? error.message : "Save sources failed");
    }
  }

  async function reimportSkillSources() {
    setConfigStatus("Reimporting saved skill sources...");
    try {
      const response = await fetchJson<{ settings?: SkillSettings }>(
        "/api/agent/settings/skills/reimport",
        { method: "POST" },
      );
      setSkills(response.settings?.skills ?? []);
      setSkillSources(response.settings?.sources?.length ? response.settings.sources : [""]);
      setConfigStatus("Saved skill sources reimported");
    } catch (error) {
      setConfigStatus(error instanceof Error ? error.message : "Reimport failed");
    }
  }

  async function refreshMcpStatus() {
    setConfigStatus("Testing MCP servers...");
    try {
      const response = await fetchJson<McpStatusResponse>(
        "/api/agent/settings/mcp/refresh",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      setMcpStatus(response.servers ?? []);
      setConfigStatus("MCP status refreshed");
    } catch (error) {
      setConfigStatus(error instanceof Error ? error.message : "MCP test failed");
    }
  }

  async function startMcpOAuth(name: string) {
    setConfigStatus(`Starting OAuth for ${name}...`);
    try {
      const response = await fetchJson<{
        authorized?: boolean;
        authorizationUrl?: string;
      }>("/api/agent/settings/mcp/oauth/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (response.authorizationUrl) {
        setOauthLinks((current) => ({ ...current, [name]: response.authorizationUrl ?? "" }));
        setConfigStatus(`OAuth link ready for ${name}`);
      } else {
        setConfigStatus(response.authorized ? `${name} is already authorized` : `OAuth started for ${name}`);
      }
      await refreshMcpStatus();
    } catch (error) {
      setConfigStatus(error instanceof Error ? error.message : "OAuth start failed");
    }
  }

  function updateSkillSource(index: number, value: string) {
    setSkillSources((current) =>
      current.map((source, sourceIndex) => sourceIndex === index ? value : source),
    );
  }

  function addSkillSource(source = "") {
    setSkillSources((current) => [...current, source]);
  }

  function removeSkillSource(index: number) {
    setSkillSources((current) => {
      const next = current.filter((_, sourceIndex) => sourceIndex !== index);
      return next.length ? next : [""];
    });
  }

  function pasteSkillSources(event: React.ClipboardEvent<HTMLInputElement>, index: number) {
    const pasted = parseSkillSourceText(event.clipboardData.getData("text"));
    if (pasted.length <= 1) return;
    event.preventDefault();
    setSkillSources((current) => [
      ...current.slice(0, index),
      ...pasted,
      ...current.slice(index + 1),
    ]);
  }

  function handleSkillSourceKeyDown(event: React.KeyboardEvent<HTMLInputElement>, index: number) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    setSkillSources((current) => [
      ...current.slice(0, index + 1),
      "",
      ...current.slice(index + 1),
    ]);
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
                <div>
                  <h3>Skills</h3>
                  <small>{skills.length} installed / {normalizeSkillSources(skillSources).length} sources</small>
                </div>
              </header>
              <div className="source-field">
                <div className="field-heading">
                  <span>Sources</span>
                  <button type="button" className="text-button" onClick={() => addSkillSource()}>
                    Add Source
                  </button>
                </div>
                <div className="source-list">
                  {skillSources.map((source, index) => (
                    <div className="source-row" key={index}>
                      <span className="source-index">{index + 1}</span>
                      <input
                        className="source-input"
                        value={source}
                        onChange={(event) => updateSkillSource(index, event.target.value)}
                        onPaste={(event) => pasteSkillSources(event, index)}
                        onKeyDown={(event) => handleSkillSourceKeyDown(event, index)}
                        placeholder={SKILL_SOURCE_PLACEHOLDERS[index % SKILL_SOURCE_PLACEHOLDERS.length]}
                      />
                      <button
                        type="button"
                        className="icon-button danger-button"
                        onClick={() => removeSkillSource(index)}
                        aria-label="Remove source"
                        title="Remove source"
                      >
                        x
                      </button>
                    </div>
                  ))}
                </div>
                <div className="source-actions">
                  <button type="button" onClick={() => void saveSkillSources()}>
                    Save Sources
                  </button>
                  <button type="button" className="primary-button" onClick={() => void importSkillSource()}>
                    Import Sources
                  </button>
                  <button type="button" onClick={() => void reimportSkillSources()}>
                    Reimport Saved
                  </button>
                </div>
              </div>
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
                <div>
                  <h3>MCP Servers</h3>
                  <small>{mcpStatus.length} configured</small>
                </div>
                <div className="button-row">
                  <button type="button" onClick={() => void refreshMcpStatus()}>
                    Test
                  </button>
                  <button
                    type="button"
                    className="primary-button"
                    onClick={() => void saveConfig("/api/agent/settings/mcp", mcpText)}
                  >
                    Save
                  </button>
                </div>
              </header>
              <textarea
                className="json-editor"
                spellCheck={false}
                value={mcpText}
                onChange={(event) => setMcpText(event.target.value)}
              />
              <div className="mcp-status-list">
                {mcpStatus.length === 0 ? (
                  <p>No MCP servers tested.</p>
                ) : (
                  mcpStatus.map((server) => (
                    <section className={`mcp-status ${server.status}`} key={server.name}>
                      <div>
                        <strong>{server.name}</strong>
                        <span>{server.status}{server.cached ? " / cached" : ""}</span>
                      </div>
                      <small>{server.transport ?? server.url}</small>
                      <div className="metric-row">
                        <span>{server.toolCount ?? 0} tools</span>
                        <span>{server.promptCount ?? 0} prompts</span>
                        <span>{server.resourceCount ?? 0} resources</span>
                      </div>
                      {server.headerNames?.length ? (
                        <small>Headers: {server.headerNames.join(", ")}</small>
                      ) : null}
                      {server.oauth?.enabled ? (
                        <div className="oauth-row">
                          <span>{server.oauth.authorized ? "OAuth authorized" : "OAuth required"}</span>
                          <button type="button" onClick={() => void startMcpOAuth(server.name)}>
                            Start OAuth
                          </button>
                          {server.oauth.authorizationUrl || oauthLinks[server.name] ? (
                            <a
                              className="link-button"
                              href={server.oauth.authorizationUrl ?? oauthLinks[server.name]}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Authorize
                            </a>
                          ) : null}
                        </div>
                      ) : null}
                      {server.listChanged &&
                      (server.listChanged.tools || server.listChanged.prompts || server.listChanged.resources) ? (
                        <small>
                          List change notifications: {[
                            server.listChanged.tools ? "tools" : "",
                            server.listChanged.prompts ? "prompts" : "",
                            server.listChanged.resources ? "resources" : "",
                          ].filter(Boolean).join(", ")}
                        </small>
                      ) : null}
                      {server.error ? <p>{server.error}</p> : null}
                      {server.tools?.length ? (
                        <div className="catalog-list">
                          {server.tools.slice(0, 6).map((tool) => (
                            <span key={tool.name}>{tool.name}</span>
                          ))}
                        </div>
                      ) : null}
                    </section>
                  ))
                )}
              </div>
            </article>

            <article className="config-editor">
              <header>
                <div>
                  <h3>Permissions</h3>
                  <small>tool pattern to ask / allow / deny</small>
                </div>
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => void saveConfig("/api/agent/settings/permissions", permissionText)}
                >
                  Save
                </button>
              </header>
              <textarea
                className="json-editor compact"
                spellCheck={false}
                value={permissionText}
                onChange={(event) => setPermissionText(event.target.value)}
              />
            </article>

            <article className="config-editor span-wide">
              <header>
                <div>
                  <h3>Activity</h3>
                  <small>{activity.length} recent events</small>
                </div>
                <button type="button" onClick={() => void loadConfig()}>
                  Refresh
                </button>
              </header>
              <div className="activity-list">
                {activity.length === 0 ? (
                  <p>No recent activity.</p>
                ) : (
                  activity.map((event) => (
                    <section key={event.id}>
                      <div>
                        <strong>{event.type}</strong>
                        <span>{formatTime(event.created_at)}</span>
                      </div>
                      <p>{event.summary}</p>
                      {event.channel ? <small>{event.channel}:{event.chatId ?? "default"}</small> : null}
                      {event.data ? <code>{stringifyShort(event.data, 360)}</code> : null}
                    </section>
                  ))
                )}
              </div>
            </article>

            <article className="config-editor">
              <header>
                <div>
                  <h3>Tool Outputs</h3>
                  <small>{toolOutputs.length} stored artifacts</small>
                </div>
              </header>
              <div className="artifact-list">
                {toolOutputs.length === 0 ? (
                  <p>No stored tool outputs.</p>
                ) : (
                  toolOutputs.map((output) => (
                    <section key={output.id}>
                      <strong>{output.toolName}</strong>
                      <span>{formatBytes(output.size)} / expires {formatTime(output.expires_at)}</span>
                      <a href={output.outputUrl} target="_blank" rel="noreferrer">
                        Open output
                      </a>
                    </section>
                  ))
                )}
              </div>
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

const SKILL_SOURCE_PLACEHOLDERS = [
  "vercel-labs/agent-skills",
  "owner/repo/skills/my-skill",
  "owner/repo@skill-name",
  "https://github.com/owner/repo/tree/main/skills/example",
];

function parseSkillSourceText(value: string) {
  return value.split(/[\s,]+/).map((source) => source.trim()).filter(Boolean);
}

function normalizeSkillSources(values: string[]) {
  return [...new Set(values.flatMap(parseSkillSourceText))];
}

function formatTime(value: number) {
  return new Date(value).toLocaleString();
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function stringifyShort(value: unknown, maxChars: number) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > maxChars ? `${text.slice(0, maxChars - 3)}...` : text;
}

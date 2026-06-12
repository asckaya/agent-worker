import { Hono, type Context, type Next } from "hono";
import {
  createExpiredSessionCookie,
  createSessionCookie,
  verifySessionCookie,
} from "./auth/cookie";
import { handleTelegramWebhook } from "./channels/telegram";
import { handleTestChannelRequest } from "./channels/test";
import { UserAgentObject } from "./do/UserAgentObject";
import type { Env } from "./types";

export { UserAgentObject };

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ ok: true }));

app.post("/api/tg/webhook", (c) => handleTelegramWebhook(c.req.raw, c.env, c.executionCtx));

app.use("/api/test-channel", requireAdmin);
app.use("/api/test-channel/*", requireAdmin);
app.all("/api/test-channel", (c) => handleTestChannelRequest(c.req.raw, c.env, c.executionCtx));
app.all("/api/test-channel/*", (c) => handleTestChannelRequest(c.req.raw, c.env, c.executionCtx));

app.post("/api/auth/login", async (c) => {
  const adminToken = c.env.ADMIN_TOKEN;
  if (!adminToken) {
    return c.json({ error: "ADMIN_TOKEN is not configured." }, 500);
  }

  const body = (await c.req.json().catch(() => ({}))) as { token?: string };
  if (body.token !== adminToken) {
    return c.json({ error: "Invalid token." }, 401);
  }

  const secureCookie = new URL(c.req.url).protocol === "https:";
  const cookie = await createSessionCookie(adminToken, { secure: secureCookie });
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": cookie,
    },
  });
});

app.post("/api/auth/logout", (c) => {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": createExpiredSessionCookie(new URL(c.req.url).protocol === "https:"),
    },
  });
});

app.get("/api/auth/me", async (c) => {
  const adminToken = c.env.ADMIN_TOKEN;
  if (!adminToken) return c.json({ authenticated: false });
  return c.json({
    authenticated: await verifySessionCookie(c.req.raw, adminToken),
  });
});

app.use("/api/agent/*", requireAdmin);

app.all("/api/agent/*", async (c) => {
  const stub = getAgentObject(c.env);
  const url = new URL(c.req.url);
  url.pathname = url.pathname.replace(/^\/api\/agent/, "") || "/";
  return stub.fetch(new Request(url.toString(), c.req.raw));
});

app.notFound((c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;

async function requireAdmin(c: Context<{ Bindings: Env }>, next: Next) {
  const adminToken = c.env.ADMIN_TOKEN;
  if (!adminToken) {
    return c.json({ error: "ADMIN_TOKEN is not configured." }, 500);
  }
  if (!(await isAdminRequest(c.req.raw, adminToken))) {
    return c.json({ error: "Unauthorized." }, 401);
  }
  await next();
}

async function isAdminRequest(request: Request, adminToken: string) {
  if (request.headers.get("Authorization") === `Bearer ${adminToken}`) {
    return true;
  }

  return verifySessionCookie(request, adminToken);
}

function getAgentObject(env: Env) {
  const id = env.AGENT_OBJECT.idFromName("agent:default");
  return env.AGENT_OBJECT.get(id);
}

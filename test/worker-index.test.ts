import { describe, expect, it, vi } from "vitest";
import app from "../src/worker/index";
import type { Env } from "../src/worker/types";

describe("worker entry routes", () => {
  it("keeps health public", async () => {
    const response = await app.fetch(request("/api/health"), env({}));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("serves unmatched routes from Workers Assets", async () => {
    const assetFetch = vi.fn(async () => new Response("status page", { status: 200 }));
    const response = await app.fetch(
      request("/"),
      env({
        ASSETS: { fetch: assetFetch } as unknown as Fetcher,
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("status page");
    expect(assetFetch).toHaveBeenCalledWith(expect.objectContaining({ url: "https://example.com/" }));
  });

  it("protects agent routes with admin auth", async () => {
    const response = await app.fetch(
      request("/api/agent/state"),
      env({
        ADMIN_TOKEN: "admin-token",
        AGENT_OBJECT: agentNamespace(vi.fn()),
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized." });
  });

  it("requires ADMIN_TOKEN for protected routes", async () => {
    const response = await app.fetch(
      request("/api/agent/state"),
      env({
        AGENT_OBJECT: agentNamespace(vi.fn()),
      }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "ADMIN_TOKEN is not configured.",
    });
  });

  it("forwards authorized agent API requests to the Durable Object", async () => {
    let forwardedPath = "";
    const agentFetch = vi.fn(async (forwardedRequest: Request) => {
      forwardedPath = new URL(forwardedRequest.url).pathname;
      return Response.json({ ok: true, from: "agent" });
    });

    const response = await app.fetch(
      request("/api/agent/state", {
        headers: { Authorization: "Bearer admin-token" },
      }),
      env({
        ADMIN_TOKEN: "admin-token",
        AGENT_OBJECT: agentNamespace(agentFetch),
      }),
    );

    expect(response.status).toBe(200);
    expect(forwardedPath).toBe("/state");
    expect(agentFetch).toHaveBeenCalledOnce();
    await expect(response.json()).resolves.toEqual({ ok: true, from: "agent" });
  });

  it("supports signed-cookie admin sessions", async () => {
    const loginResponse = await app.fetch(
      request("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "admin-token" }),
      }),
      env({ ADMIN_TOKEN: "admin-token" }),
    );
    const sessionCookie = loginResponse.headers.get("Set-Cookie")?.split(";")[0];
    expect(loginResponse.status).toBe(200);
    expect(sessionCookie).toMatch(/^agent_session=/);

    const meResponse = await app.fetch(
      request("/api/auth/me", {
        headers: { Cookie: sessionCookie ?? "" },
      }),
      env({ ADMIN_TOKEN: "admin-token" }),
    );
    await expect(meResponse.json()).resolves.toEqual({ authenticated: true });

    let forwardedPath = "";
    const agentFetch = vi.fn(async (forwardedRequest: Request) => {
      forwardedPath = new URL(forwardedRequest.url).pathname;
      return Response.json({ ok: true });
    });
    const agentResponse = await app.fetch(
      request("/api/agent/state", {
        headers: { Cookie: sessionCookie ?? "" },
      }),
      env({
        ADMIN_TOKEN: "admin-token",
        AGENT_OBJECT: agentNamespace(agentFetch),
      }),
    );

    expect(agentResponse.status).toBe(200);
    expect(forwardedPath).toBe("/state");
  });

  it("reports unauthenticated sessions and clears login cookies", async () => {
    const meResponse = await app.fetch(request("/api/auth/me"), env({}));
    await expect(meResponse.json()).resolves.toEqual({ authenticated: false });

    const invalidLoginResponse = await app.fetch(
      request("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "wrong-token" }),
      }),
      env({ ADMIN_TOKEN: "admin-token" }),
    );
    expect(invalidLoginResponse.status).toBe(401);
    await expect(invalidLoginResponse.json()).resolves.toEqual({ error: "Invalid token." });

    const logoutResponse = await app.fetch(
      request("/api/auth/logout", { method: "POST" }),
      env({ ADMIN_TOKEN: "admin-token" }),
    );
    expect(logoutResponse.status).toBe(200);
    expect(logoutResponse.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });

  it("protects the HTTP test channel", async () => {
    const response = await app.fetch(
      request("/api/test-channel/state"),
      env({
        ADMIN_TOKEN: "admin-token",
        AGENT_OBJECT: agentNamespace(vi.fn()),
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized." });
  });
});

function request(path: string, init?: RequestInit) {
  return new Request(`https://example.com${path}`, init);
}

function env(values: Partial<Env>) {
  return values as Env;
}

function agentNamespace(fetchImpl: (request: Request) => Promise<Response>) {
  return {
    idFromName: vi.fn(() => "agent-id"),
    get: vi.fn(() => ({
      fetch: fetchImpl,
    })),
  } as unknown as DurableObjectNamespace;
}

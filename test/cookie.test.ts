import { describe, expect, it } from "vitest";
import {
  createExpiredSessionCookie,
  createSessionCookie,
  parseCookies,
  verifySessionCookie,
} from "../src/worker/auth/cookie";

describe("session cookies", () => {
  it("parses cookies", () => {
    expect(parseCookies("a=1; b=hello%20world")).toEqual({
      a: "1",
      b: "hello world",
    });
  });

  it("creates and verifies signed cookies", async () => {
    const cookie = await createSessionCookie("secret", { secure: false, now: Date.now() });
    const request = new Request("http://example.com", {
      headers: { Cookie: cookie.split(";")[0] },
    });

    expect(cookie).not.toContain("Secure");
    expect(await verifySessionCookie(request, "secret")).toBe(true);
    expect(await verifySessionCookie(request, "wrong")).toBe(false);
  });

  it("can create secure expired cookies", () => {
    expect(createExpiredSessionCookie(true)).toContain("Secure");
    expect(createExpiredSessionCookie(false)).not.toContain("Secure");
  });
});

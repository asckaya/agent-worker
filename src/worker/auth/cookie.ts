const SESSION_COOKIE = "agent_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

export function getSessionCookieName() {
  return SESSION_COOKIE;
}

export function parseCookies(header: string | null): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;

  for (const part of header.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (!rawName || rawValue.length === 0) continue;
    cookies[rawName] = decodeURIComponent(rawValue.join("="));
  }

  return cookies;
}

export async function createSessionCookie(secret: string, options: { secure?: boolean; now?: number } = {}) {
  const now = options.now ?? Date.now();
  const expiresAt = Math.floor(now / 1000) + SESSION_TTL_SECONDS;
  const payload = `v1.${expiresAt}`;
  const signature = await sign(payload, secret);
  const value = `${payload}.${signature}`;

  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];
  if (options.secure ?? true) parts.splice(4, 0, "Secure");
  return parts.join("; ");
}

export function createExpiredSessionCookie(secure = true) {
  const parts = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) parts.splice(4, 0, "Secure");
  return parts.join("; ");
}

export async function verifySessionCookie(request: Request, secret: string) {
  const cookies = parseCookies(request.headers.get("Cookie"));
  const value = cookies[SESSION_COOKIE];
  if (!value) return false;

  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return false;

  const expiresAt = Number(parts[1]);
  if (!Number.isFinite(expiresAt)) return false;
  if (expiresAt < Math.floor(Date.now() / 1000)) return false;

  const payload = `v1.${parts[1]}`;
  const expected = await sign(payload, secret);
  return timingSafeEqual(parts[2], expected);
}

async function sign(payload: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  return toBase64Url(new Uint8Array(signature));
}

function toBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function timingSafeEqual(a: string, b: string) {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;

  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    diff |= left[i] ^ right[i];
  }
  return diff === 0;
}

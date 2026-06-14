import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

describe("Cloudflare runtime boundary", () => {
  it("deploys through a Worker with Workers Assets and a SQLite Durable Object", () => {
    const wrangler = parseJsonc(readFileSync("wrangler.jsonc", "utf8")) as {
      main?: unknown;
      assets?: unknown;
      durable_objects?: unknown;
      migrations?: unknown;
      compatibility_flags?: unknown;
      d1_databases?: unknown;
      kv_namespaces?: unknown;
      r2_buckets?: unknown;
      queues?: unknown;
    };

    expect(wrangler.main).toBe("src/worker/index.ts");
    expect(wrangler.assets).toMatchObject({
      directory: "./dist/client",
      binding: "ASSETS",
    });
    expect(wrangler.durable_objects).toMatchObject({
      bindings: [{ name: "AGENT_OBJECT", class_name: "UserAgentObject" }],
    });
    expect(wrangler.migrations).toEqual([
      { tag: "v1", new_sqlite_classes: ["UserAgentObject"] },
    ]);
    expect(wrangler.compatibility_flags ?? []).not.toContain("nodejs_compat");
    expect(wrangler.d1_databases).toBeUndefined();
    expect(wrangler.kv_namespaces).toBeUndefined();
    expect(wrangler.r2_buckets).toBeUndefined();
    expect(wrangler.queues).toBeUndefined();
  });

  it("keeps local scripts on Wrangler instead of a separate server runtime", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(pkg.scripts?.dev).toContain("wrangler dev");
    expect(pkg.scripts?.build).toContain("wrangler deploy --dry-run");
    expect(Object.values(pkg.scripts ?? {}).join("\n")).not.toMatch(
      /\b(Bun\.serve|deno serve|next dev|next build|node --watch|tsx watch)\b/,
    );
  });

  it("does not use Node-only or non-Cloudflare server APIs in deployed source", () => {
    const forbidden = [
      /(?:import|export)\s+[^;]*from\s+["']node:/,
      /import\s+["']node:/,
      /require\(["']node:/,
      /(?:import|export)\s+[^;]*from\s+["'](?:fs|path|child_process|net|tls|http|https)["']/,
      /require\(["'](?:fs|path|child_process|net|tls|http|https)["']\)/,
      /\bBun\.serve\b/,
      /\bDeno\.serve\b/,
      /\bexpress\s*\(/,
      /\bfastify\s*\(/,
      /\bcreateServer\s*\(/,
    ];

    const violations = sourceFiles("src")
      .flatMap((file) => {
        const content = readFileSync(file, "utf8");
        return forbidden
          .filter((pattern) => pattern.test(content))
          .map((pattern) => `${relative(process.cwd(), file)} matched ${pattern}`);
      });

    expect(violations).toEqual([]);
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(path) && !path.endsWith("vite-env.d.ts") ? [path] : [];
  });
}

function parseJsonc(input: string) {
  let output = "";
  let inString = false;
  let escaping = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    const next = input[i + 1];

    if (inString) {
      output += char;
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      output += char;
      continue;
    }

    if (char === "/" && next === "/") {
      while (i < input.length && input[i] !== "\n") i += 1;
      output += "\n";
      continue;
    }

    if (char === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i += 1;
      i += 1;
      continue;
    }

    output += char;
  }

  return JSON.parse(output);
}

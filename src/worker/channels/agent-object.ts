import type { Env } from "../types";

export async function fetchAgentObject(
  env: Env,
  requestUrl: string,
  pathnameAndSearch: string,
  init: RequestInit,
) {
  const id = env.AGENT_OBJECT.idFromName("agent:default");
  const stub = env.AGENT_OBJECT.get(id);
  const url = new URL(requestUrl);
  const [pathname, search = ""] = pathnameAndSearch.split("?", 2);
  url.pathname = pathname;
  url.search = search ? `?${search}` : "";
  return stub.fetch(new Request(url.toString(), init));
}

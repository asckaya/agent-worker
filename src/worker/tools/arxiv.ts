import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import type { ToolDefinition } from "./registry";

const ARXIV_API_URL = "https://export.arxiv.org/api/query";
const MAX_ARXIV_RESULTS = 8;
const MAX_SUMMARY_CHARS = 1_500;
const arxivXmlParser = new XMLParser({
  ignoreAttributes: false,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
});

const ArxivSearchInputSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .describe("arXiv search query. Use topic terms, author names, or title terms."),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(MAX_ARXIV_RESULTS)
    .optional()
    .default(5)
    .describe("Maximum number of papers to return."),
  sortBy: z
    .enum(["relevance", "lastUpdatedDate", "submittedDate"])
    .optional()
    .default("relevance")
    .describe("arXiv sort field."),
  sortOrder: z
    .enum(["ascending", "descending"])
    .optional()
    .default("descending")
    .describe("Sort direction."),
});

type ArxivSearchInput = z.infer<typeof ArxivSearchInputSchema>;

export interface ArxivSearchResult {
  query: string;
  totalResults?: number;
  entries: Array<{
    id: string;
    title: string;
    authors: string[];
    summary: string;
    published?: string;
    updated?: string;
    categories: string[];
    pdfUrl?: string;
    absUrl?: string;
  }>;
}

export const arxivSearchTool: ToolDefinition<ArxivSearchInput, ArxivSearchResult> = {
  name: "arxiv_search",
  description:
    "Search arXiv papers through the public arXiv API. Use for academic paper discovery, recent research, authors, and paper summaries.",
  inputSchema: ArxivSearchInputSchema,
  risk: "read",
  requiresApproval: false,
  toolset: "research",
  maxResultChars: 20_000,
  presentation: {
    label: "arXiv Search",
    icon: "book-open",
  },
  async execute(ctx, input) {
    const url = new URL(ARXIV_API_URL);
    url.searchParams.set("search_query", input.query);
    url.searchParams.set("start", "0");
    url.searchParams.set("max_results", String(input.maxResults));
    url.searchParams.set("sortBy", input.sortBy);
    url.searchParams.set("sortOrder", input.sortOrder);

    const response = await ctx.fetch(url.toString(), {
      headers: { "User-Agent": "agent-worker/0.1 (arxiv_search)" },
    });
    if (!response.ok) {
      throw new Error(`arXiv request failed: ${response.status}`);
    }

    const xml = await response.text();
    return parseArxivFeed(xml, input.query);
  },
};

function parseArxivFeed(xml: string, query: string): ArxivSearchResult {
  const parsed = arxivXmlParser.parse(xml) as {
    feed?: {
      "opensearch:totalResults"?: string;
      entry?: unknown;
    };
  };
  const feed = parsed.feed ?? {};
  return {
    query,
    totalResults: toOptionalNumber(feed["opensearch:totalResults"]),
    entries: asArray(feed.entry).map(parseArxivEntry),
  };
}

function parseArxivEntry(entry: unknown): ArxivSearchResult["entries"][number] {
  const record = toRecord(entry);
  const id = readString(record.id);
  const links = readArxivLinks(record.link);
  const categories = asArray(record.category)
    .map((category) => readString(toRecord(category)["@_term"]))
    .filter(Boolean);

  return {
    id,
    title: normalizeWhitespace(readString(record.title)),
    authors: asArray(record.author)
      .map((author) => normalizeWhitespace(readString(toRecord(author).name)))
      .filter(Boolean),
    summary: normalizeWhitespace(readString(record.summary)).slice(0, MAX_SUMMARY_CHARS),
    published: optionalString(record.published),
    updated: optionalString(record.updated),
    categories,
    pdfUrl: links.pdfUrl,
    absUrl: links.absUrl ?? id,
  };
}

function readArxivLinks(value: unknown) {
  let pdfUrl: string | undefined;
  let absUrl: string | undefined;
  for (const link of asArray(value)) {
    const record = toRecord(link);
    const href = optionalString(record["@_href"]);
    if (!href) continue;
    const title = optionalString(record["@_title"]);
    const rel = optionalString(record["@_rel"]);
    if (title === "pdf" || href.endsWith(".pdf")) {
      pdfUrl = href;
    } else if (rel === "alternate") {
      absUrl = href;
    }
  }
  return { pdfUrl, absUrl };
}

function asArray(value: unknown) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function toRecord(value: unknown) {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function optionalString(value: unknown) {
  const text = readString(value);
  return text || undefined;
}

function toOptionalNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

import type { StoredMemory } from "../types";

export interface MemoryProvider {
  list(): StoredMemory[];
  count(): number;
  save(content: string): StoredMemory;
  delete(id: string): void;
  search(query: string): Promise<string[]>;
}

export interface DurableObjectMemoryProviderOptions {
  maxItems: number;
  maxChars: number;
  maxRelevantItems: number;
}

type DurableObjectSqlStorage = DurableObjectState["storage"]["sql"];

export class DurableObjectMemoryProvider implements MemoryProvider {
  constructor(
    private readonly sql: DurableObjectSqlStorage,
    private readonly options: DurableObjectMemoryProviderOptions,
  ) {}

  ensureSchema() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      )
    `);
  }

  list() {
    return this.query<StoredMemory>(
      "SELECT id, content, created_at FROM memories ORDER BY created_at DESC LIMIT ?",
      this.options.maxItems,
    );
  }

  count() {
    const rows = this.query<{ count: number }>("SELECT COUNT(*) AS count FROM memories");
    return rows[0]?.count ?? 0;
  }

  save(content: string) {
    const trimmed = content.trim().replace(/\s+/g, " ").slice(0, this.options.maxChars);
    if (!trimmed) {
      throw new Error("Memory content is empty.");
    }

    const existing = this.query<StoredMemory>(
      "SELECT id, content, created_at FROM memories WHERE content = ? LIMIT 1",
      trimmed,
    )[0];
    if (existing) return existing;

    const memory: StoredMemory = {
      id: crypto.randomUUID(),
      content: trimmed,
      created_at: Date.now(),
    };

    this.sql.exec(
      "INSERT INTO memories (id, content, created_at) VALUES (?, ?, ?)",
      memory.id,
      memory.content,
      memory.created_at,
    );
    this.prune();
    return memory;
  }

  delete(id: string) {
    if (!id) return;
    this.sql.exec("DELETE FROM memories WHERE id = ?", id);
  }

  async search(query: string) {
    return searchStoredMemories(this.list(), query, this.options.maxRelevantItems).map(
      (memory) => memory.content,
    );
  }

  private prune() {
    const overflow = this.query<{ id: string }>(
      "SELECT id FROM memories ORDER BY created_at DESC",
    ).slice(this.options.maxItems);

    for (const row of overflow) {
      this.delete(row.id);
    }
  }

  private query<T>(sql: string, ...bindings: Array<string | number | null>) {
    return [...this.sql.exec(sql, ...bindings)] as T[];
  }
}

export function searchStoredMemories(
  memories: StoredMemory[],
  query: string,
  maxRelevantItems: number,
) {
  const terms = tokenizeMemoryQuery(query);
  if (terms.length === 0) {
    return memories.slice(0, maxRelevantItems);
  }

  const scored = memories
    .map((memory) => {
      const lowerContent = memory.content.toLowerCase();
      const score = terms.reduce(
        (total, term) => total + (lowerContent.includes(term) ? 1 : 0),
        0,
      );
      return { memory, score };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || right.memory.created_at - left.memory.created_at);

  const relevant = scored.length > 0 ? scored.map((item) => item.memory) : memories;
  return relevant.slice(0, maxRelevantItems);
}

export function tokenizeMemoryQuery(query: string) {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^\p{L}\p{N}_-]+/u)
        .map((term) => term.trim())
        .filter((term) => term.length >= 2)
        .slice(0, 12),
    ),
  ];
}

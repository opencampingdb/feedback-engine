import type { ListableKV } from "../src/recent-kv.js";
import type { KVLike } from "../src/ratelimit.js";

/** A fake KV namespace: listable, as the copy reads it, and writable, as tests and the rate limits use it. */
export type FakeKv = ListableKV &
  KVLike & {
    put(key: string, value: string, options?: { metadata?: unknown; expirationTtl?: number }): Promise<void>;
    data: Map<string, { value: string; metadata?: unknown }>;
    lists: number;
  };

/**
 * A KV namespace with list and metadata, as Workers KV has, paging two keys at
 * a time. Like Workers KV it refuses metadata over 1024 bytes as JSON.
 */
export function listableKv(): FakeKv {
  const data = new Map<string, { value: string; metadata?: unknown }>();
  const kv = {
    data,
    lists: 0,
    get: async (k: string) => data.get(k)?.value ?? null,
    put: async (k: string, value: string, options?: { metadata?: unknown; expirationTtl?: number }) => {
      if (options?.metadata !== undefined && new TextEncoder().encode(JSON.stringify(options.metadata)).length > 1024) {
        throw new Error("KV PUT failed: 413 Metadata length limit exceeded");
      }
      data.set(k, { value, ...(options?.metadata !== undefined ? { metadata: options.metadata } : {}) });
    },
    delete: async (k: string) => void data.delete(k),
    list: async ({ prefix, cursor }: { prefix?: string; cursor?: string }) => {
      kv.lists += 1;
      const names = [...data.keys()].filter((k) => k.startsWith(prefix ?? "")).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = names.slice(start, start + 2);
      const done = start + 2 >= names.length;
      return {
        keys: page.map((name) => ({ name, metadata: data.get(name)!.metadata })),
        list_complete: done,
        ...(done ? {} : { cursor: String(start + 2) }),
      };
    },
  };
  return kv;
}

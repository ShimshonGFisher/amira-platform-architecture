/**
 * embeddings.ts — pure-Bun client for the local embedder sidecar.
 *
 * The embedding model runs in a tiny Rust sidecar (shared with the original Amira
 * service) reachable over a Unix domain socket, so this codebase stays pure Bun
 * with no native ML dependency — just fetch. bge-small-en-v1.5, 384-dim,
 * L2-normalised (so pgvector cosine distance is meaningful).
 */

const SOCKET = process.env.EMBED_SOCKET ?? '/run/amira-embed.sock';

/** bge-small-en-v1.5 dimensionality. Must match migration 004 vector(384). */
export const EMBED_DIM = 384;

// bge retrieval convention: prefix the QUERY (not the stored passages) with a short
// instruction. Marginal but free recall gain.
const QUERY_INSTRUCTION = 'Represent this sentence for searching relevant passages: ';

type UnixRequestInit = RequestInit & { unix?: string };

interface EmbedResponse {
  model: string;
  dim: number;
  embeddings: number[][];
}

async function callEmbed(inputs: string[]): Promise<number[][]> {
  if (inputs.length === 0) return [];
  const res = await fetch('http://localhost/embed', {
    unix: SOCKET,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: inputs }),
  } as UnixRequestInit);
  if (!res.ok) throw new Error(`embedder responded ${res.status}: ${await res.text()}`);
  return ((await res.json()) as EmbedResponse).embeddings;
}

/** Embed a single passage/document (no query instruction). */
export async function embed(text: string): Promise<number[]> {
  const [vec] = await callEmbed([text]);
  return vec;
}

/** Embed many passages in one round-trip. */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  return callEmbed(texts);
}

/** Embed a search query (adds the bge query instruction prefix). */
export async function embedQuery(text: string): Promise<number[]> {
  return embed(QUERY_INSTRUCTION + text);
}

/** Stable content hash for idempotent re-embedding (only changed rows re-embed). */
export function contentHash(text: string): string {
  return new Bun.CryptoHasher('sha256').update(text).digest('hex');
}

/** Format a vector as the pgvector text literal `[1,2,3]` for a `${v}::vector` bind. */
export function toVector(v: number[]): string {
  return `[${v.join(',')}]`;
}

/** True if the sidecar is reachable (used by reindex scripts / health checks). */
export async function embedderHealthy(): Promise<boolean> {
  try {
    const res = await fetch('http://localhost/health', { unix: SOCKET } as UnixRequestInit);
    return res.ok;
  } catch {
    return false;
  }
}

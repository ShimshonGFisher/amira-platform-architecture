/**
 * knowledge.ts — per-tenant knowledge-base RAG.
 *
 * Optional reference corpus retrieved into the UNCACHED per-turn context block,
 * leaving the two cached brain blocks untouched (so cache hit rates are unchanged).
 * Hybrid retrieval: dense (pgvector cosine) + lexical (Postgres FTS), fused with
 * Reciprocal Rank Fusion (k=60).
 *
 * retrieveKnowledgeBlock is deliberately defensive: a tenant with no knowledge, a
 * query that matches nothing, or a down sidecar all yield '' — so the reply
 * pipeline folds it in unconditionally and is never blocked by it.
 */

import { sql } from '../db/client.ts';
import { logger } from './logger.ts';
import { contentHash, embedBatch, embedQuery, toVector } from './embeddings.ts';

const log = logger.child({ scope: 'knowledge' });

const RETRIEVE_K = 4; // snippets folded into the context block

interface KnowledgeHit {
  title: string | null;
  content: string;
}

/**
 * Retrieve the most relevant knowledge snippets for this tenant + customer message,
 * formatted as a context block. Returns '' when the tenant has no knowledge, nothing
 * matches, or retrieval fails.
 */
export async function retrieveKnowledgeBlock(
  tenantId: string,
  queryText: string,
  businessName: string,
  k = RETRIEVE_K,
): Promise<string> {
  const q = queryText.trim();
  if (!q) return '';

  try {
    const vec = toVector(await embedQuery(q));

    // Hybrid: dense cosine + lexical FTS, fused with RRF (k=60). Both arms are
    // tenant-scoped, so the outer join inherits the scoping.
    const hits = (await sql`
      WITH dense AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY embedding <=> ${vec}::vector) AS rank
        FROM tenant_knowledge
        WHERE tenant_id = ${tenantId} AND embedding IS NOT NULL
        ORDER BY embedding <=> ${vec}::vector
        LIMIT 30
      ),
      lexical AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY ts_rank_cd(fts, query) DESC) AS rank
        FROM tenant_knowledge, websearch_to_tsquery('english', ${q}) AS query
        WHERE tenant_id = ${tenantId} AND fts @@ query
        ORDER BY rank
        LIMIT 30
      )
      SELECT k.title, k.content,
             COALESCE(1.0 / (60 + d.rank), 0) + COALESCE(1.0 / (60 + l.rank), 0) AS rrf
      FROM tenant_knowledge k
      LEFT JOIN dense d   ON d.id = k.id
      LEFT JOIN lexical l ON l.id = k.id
      WHERE d.id IS NOT NULL OR l.id IS NOT NULL
      ORDER BY rrf DESC
      LIMIT ${k}
    `) as KnowledgeHit[];

    if (hits.length === 0) return '';

    const body = hits
      .map((h) => (h.title ? `### ${h.title}\n${h.content}` : h.content))
      .join('\n\n');

    return (
      `# Reference from ${businessName}'s knowledge base\n` +
      `Use the following only if it's relevant to the customer's message. Don't invent beyond it; ` +
      `if it doesn't answer them, say you'll check with the team rather than guessing.\n\n` +
      body
    );
  } catch (err) {
    log.warn({ err: String(err), tenantId }, 'knowledge retrieval failed — replying without it');
    return '';
  }
}

export interface KnowledgeItem {
  source?: string;
  title?: string;
  content: string;
}

/** Insert knowledge rows for a tenant (does not embed; run reindexTenantKnowledge after). */
export async function addKnowledge(tenantId: string, items: KnowledgeItem[]): Promise<number> {
  for (const it of items) {
    await sql`
      INSERT INTO tenant_knowledge (tenant_id, source, title, content)
      VALUES (${tenantId}, ${it.source ?? 'manual'}, ${it.title ?? null}, ${it.content})
    `;
  }
  return items.length;
}

/**
 * Embed a tenant's knowledge rows. Idempotent: only rows whose text changed (or that
 * have no vector yet) are re-embedded, keyed on content_hash.
 */
export async function reindexTenantKnowledge(
  tenantId: string,
): Promise<{ embedded: number; skipped: number }> {
  const rows = (await sql`
    SELECT id, title, content, content_hash, (embedding IS NULL) AS no_vec
    FROM tenant_knowledge WHERE tenant_id = ${tenantId}
  `) as Array<{
    id: string;
    title: string | null;
    content: string;
    content_hash: string | null;
    no_vec: boolean;
  }>;

  const targets: string[] = [];
  const texts: string[] = [];
  const hashOf = new Map<string, string>();
  let skipped = 0;

  for (const r of rows) {
    const text = [r.title, r.content].filter(Boolean).join('\n');
    const h = contentHash(text);
    hashOf.set(r.id, h);
    if (r.content_hash === h && !r.no_vec) {
      skipped++;
      continue;
    }
    targets.push(r.id);
    texts.push(text);
  }

  if (targets.length === 0) return { embedded: 0, skipped };

  const vectors = await embedBatch(texts);
  for (let i = 0; i < targets.length; i++) {
    await sql`
      UPDATE tenant_knowledge
      SET embedding = ${toVector(vectors[i])}::vector, content_hash = ${hashOf.get(targets[i])!}
      WHERE id = ${targets[i]}
    `;
  }
  return { embedded: targets.length, skipped };
}

# Per-tenant knowledge base (RAG)

Optional retrieval layer that lets a tenant carry a large, situational reference corpus
(FAQs, material specs, care guides, policies) **without bloating the cached brain**.

## Why this shape

The platform already composes each tenant's brain into **two `cache_control: ephemeral`
system blocks** — so the "large instructions" cost is already solved by caching. RAG is added
only where it genuinely fits: the **uncached per-turn `contextBlock`**. At reply time we embed
the customer's message, retrieve the top-k relevant snippets, and fold them in beneath the brain
— leaving the cached blocks (and their cache-hit rate) **untouched**.

```
ingest.ts ─► retrieveKnowledgeBlock(tenant, msg) ─► assembleContext(…, knowledgeBlock)
                     │ (hybrid: pgvector + FTS, RRF)              │
                     ▼                                            ▼
              tenant_knowledge                        uncached context block ─► composeReply()
              (embedding + fts)                       (cached brain blocks unchanged)
```

**Safe by construction:** `retrieveKnowledgeBlock` returns `''` when the tenant has no
knowledge, nothing matches, or the embedder sidecar is down (wrapped in try/catch). A tenant
with no rows behaves exactly as before.

## Components

- `migrations/004_tenant_knowledge.sql` — `tenant_knowledge` (embedding `vector(384)` + generated
  `fts`), HNSW + GIN indexes.
- `src/lib/embeddings.ts` — pure-Bun client to the shared embedder sidecar (Unix socket).
- `src/lib/knowledge.ts` — `retrieveKnowledgeBlock` (hybrid RRF), `addKnowledge`,
  `reindexTenantKnowledge` (idempotent via `content_hash`).
- `src/lib/context.ts` / `src/ingest.ts` — wired in, mirroring the existing `availabilityBlock`.
- `src/db/seed-knowledge.ts` — demo seed + retrieval check (template for real ingestion).

## Deploy prerequisites

1. **Extension (one-time, superuser per database)** — the app migration role can't `CREATE
   EXTENSION` (pgvector isn't "trusted"):
   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;   -- in amira_platform, as a superuser
   ```
2. **Embedder sidecar** reachable at `EMBED_SOCKET` (default `/run/amira-embed.sock`) — the same
   bge-small-en-v1.5 sidecar used by the original Amira service. Optional at runtime: if it's
   down, retrieval is skipped and replies still send.
3. **Migrate** as usual (`bun run src/db/migrate.ts`) — creates `tenant_knowledge` owned by the
   app role.

> **Note for this repo's live DB:** during development an *empty* `tenant_knowledge` table was
> created in `amira_platform` by a superuser (so it's owned by `postgres`, not the app role).
> Before deploying this branch, align it once as a superuser — either
> `DROP TABLE tenant_knowledge;` (let migrate recreate it as the app role) or
> `ALTER TABLE tenant_knowledge OWNER TO <app_role>;`.

## Usage

```ts
await addKnowledge(tenantId, [{ source: 'faq', title: 'Turnaround', content: '…' }]);
await reindexTenantKnowledge(tenantId);   // idempotent; only changed rows re-embed
```
Retrieval is automatic in the reply path — nothing to call per turn.

## Verified

Proven on a throwaway copy of the schema (real migration chain + hybrid retrieval): 7 demo
snippets embedded, **5/5 conceptual queries** retrieved the correct snippet
("is platinum hypoallergenic?" → *Metals*; "are lab diamonds cheaper?" → *Lab-grown vs natural*;
"can you make my ring bigger later?" → *Resizing & warranty*; …). Conceptual questions share no
keywords with their answers, so this is the semantic-retrieval win, identical to the pattern
measured at 100% hit in the original Amira service.

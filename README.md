# AMIRA platform: hybrid RAG core

AMIRA is a multi-tenant AI concierge that I build and run for service businesses.
One deployment serves many businesses across WhatsApp, Instagram and Messenger, a
web chat widget, and voice. This repo publishes the retrieval core as a reference:
hybrid search inside Postgres, the client for a Rust embedding sidecar, and a
prompt layout that keeps prompt caching effective.

## Architecture

```
customer message
      |
      v
Bun + Hono API (TypeScript)
      |-- embed(query) over a Unix socket --> Rust sidecar (axum + fastembed)
      |                                       bge-small-en-v1.5, 384-dim
      |
      |-- one SQL round trip --------------> Postgres 16 + pgvector
      |                                       HNSW (cosine) + GIN (full-text)
      v
Claude Haiku 4.5
  system = [cached tenant rules] + [cached voice profile] + [uncached context + retrieved snippets]
```

## Design decisions

- **Hybrid retrieval, fused in SQL.** Dense vectors catch meaning ("something for
  a gift"); Postgres full-text search catches exact names and SKUs. Both run in one
  query and are merged with Reciprocal Rank Fusion (k = 60). Both arms filter on
  `tenant_id`.
- **Embeddings in a Rust sidecar.** Model inference is the one job a JavaScript
  runtime is wrong for, so a small axum + fastembed service loads bge-small-en-v1.5
  once and serves it over a Unix domain socket. The app stays pure TypeScript and
  calls it with a plain `fetch`. Inference runs on a blocking thread so the server
  stays responsive.
- **Retrieval never blocks a reply.** A tenant with no knowledge, a query with no
  match, or a sidecar that is down all return an empty block, and the reply goes
  out without it.
- **Idempotent reindexing.** Each row stores a hash of the text it was embedded
  from, so a reindex only re-embeds rows whose content changed.
- **A cache-aware prompt layout.** Each tenant's stable brain is compiled into two
  cached system blocks: its rules and guardrails, and its voice profile. Retrieved snippets go in the
  uncached per-turn block, so adding RAG doesn't lower the cache hit rate.

## Measured results

From the first AMIRA service, using an eval harness that runs labelled queries
through lexical-only, dense-only and hybrid retrieval (hit@6 / MRR):

| Corpus | Queries | Lexical | Dense | Hybrid |
| --- | --- | --- | --- | --- |
| Product catalogue, 138 items | 16 | 50% / 0.47 | 88% / 0.79 | 88% / 0.75 |
| Knowledge base | 6 | 17% / 0.17 | 100% / 1.00 | 100% / 1.00 |

- On a catalogue this small, dense retrieval alone is already strong, so hybrid
  matches its recall rather than beating it. The lexical arm is the safety net for
  exact SKUs and names as catalogues grow.
- Knowledge questions rarely share keywords with their answers ("are lab-grown
  diamonds real?"), which is why lexical search alone scores 17% there.
- Retrieving the top 6 products instead of sending the whole catalogue cut product
  context from about 3,683 tokens to about 160 per message, 96% smaller.
- Prompt caching was verified end to end: an 8,002-token block was written, then
  read back on the next call. The minimum cacheable prefix for Claude Haiku 4.5
  measured at around 4,096 tokens, so caching engages once a tenant's instructions
  grow past that.

The eval set is small and from real client data, so treat these as evidence for
the design, not benchmarks.

## Multi-tenancy

One deployment and one shared schema. Every table carries `tenant_id`, and every
query, including both retrieval arms, filters on it.

## What's in this repo

| Path | What it is |
| --- | --- |
| `core-logic/knowledge.ts` | Hybrid retrieval (RRF), knowledge ingestion, idempotent reindex |
| `core-logic/embeddings.ts` | TypeScript client for the sidecar over a Unix socket |
| `core-logic/KNOWLEDGE_RAG.md` | Design note for the per-tenant knowledge base |

The rest of the platform, including the Rust sidecar, lives in private repos:
channel adapters for WhatsApp,
Instagram and Messenger and the web widget, the voice path (OpenAI Realtime over
WebRTC with short-lived session tokens), lead capture and handover to humans, and
the admin studio. Happy to walk through it.

## Stack

TypeScript (Bun, Hono), Rust (axum, fastembed), PostgreSQL 16 with pgvector,
Claude Haiku 4.5, bge-small-en-v1.5.

## Next

- A cross-encoder reranker over the top ~40 candidates, as a `/rerank` route on
  the same sidecar
- A multilingual embedding model for non-English tenants
- Postgres row-level security, so the database enforces tenant isolation even if
  a query forgets the filter

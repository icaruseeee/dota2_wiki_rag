# Dota 2 Wiki RAG

English | [简体中文](README.zh-CN.md)

A local-first, evaluation-driven RAG system over the Chinese Dota 2 wiki
(`wiki.dota2.com.cn`). It combines entity-aware chunking, Qwen3 embeddings,
PostgreSQL + pgvector, an optional Qwen3 cross-encoder reranker, and streaming
answers from a local Qwen3.5-9B model.

This is a portfolio/reference implementation, not a production service. It is
designed to make the retrieval trade-offs visible: what is indexed, what is
measured, what is intentionally left out, and where the current pipeline still
fails.

## At a glance

| Item | Value |
| --- | --- |
| Indexable document entities | 1,120 |
| Raw entities | 128 heroes, 852 abilities, 157 mechanism articles |
| Retrieval chunks | 1,718 |
| Searchable after the runtime token filter | 1,652 chunks (`token_count >= 60`) |
| Structured metadata | 973 tags, 288 embedded forms, 139 categories |
| Embedding | Qwen3-Embedding-0.6B, 1,024 dimensions, 2,048-token context |
| Vector store | PostgreSQL + pgvector, HNSW cosine index |
| Reranker | Qwen3-Reranker-0.6B, optional |
| Generator | Qwen3.5-9B, local llama.cpp server, streamed over SSE |
| Retrieval evaluation | 18 handwritten questions |
| Answer evaluation | 115 records: 110 grounded questions + 5 out-of-domain questions |

Recorded on the target Apple M1 / 16 GB machine:

| Mode | Retrieval quality |
| --- | --- |
| Dense only | Hit@1 83%, Hit@5 94% |
| Dense + reranker | Hit@1 94%, Hit@5 100%, MRR 0.972 |

The optional reranker is accurate but slow on this machine: roughly 20-50
seconds for 20 candidates. The web UI therefore defaults to fast dense
retrieval, with reranking behind an explicit toggle.

## What makes this project worth reading

- **Entity-aware chunking instead of fixed-size splitting.** Heroes and
  abilities are usually one entity per chunk; long mechanism articles are split
  at Markdown heading boundaries and packed toward a token target.
- **Exact token accounting.** Chunk boundaries are checked with the embedding
  server's own tokenizer. A chunk that exceeds the 2,048-token hard limit causes
  the pipeline to fail instead of being silently dropped.
- **Upstream redirect stubs are handled as aliases.** Seventeen mechanism
  articles contain only a "see another page" sentence. They are excluded from
  the index, and their names are added to the target page's chunk header.
- **Idempotent ingestion.** Stable chunk keys plus content hashes make
  re-ingestion incremental; unchanged chunks are not embedded again.
- **Quality/latency is an explicit product choice.** The same retrieval path can
  run dense-only or add a cross-encoder reranker.
- **Two levels of evaluation.** Retrieval is measured with Hit@k and MRR;
  end-to-end answers are checked for context recall, answer correctness,
  citations, abstention, and numeric support.

## Architecture

```text
Offline indexing
================
data/dota2-wiki.json
        │
        │  npm run chunk
        │  - entity-level assembly
        │  - heading-aware splitting
        │  - exact /tokenize counting
        ▼
data/chunks.json  (1,718 chunks)
        │
        │  npm run ingest
        │  - md5(content) incremental check
        │  - Qwen3-Embedding, 1,024 dimensions
        │  - stable chunk_key upsert
        ▼
PostgreSQL: wiki_chunks + pgvector HNSW (cosine)

Online question answering
=========================
question
   │
   ├─ embed query (Qwen3-Embedding)
   ├─ dense recall: top 20 by cosine distance
   ├─ optional cross-encoder rerank of those 20
   ├─ select up to 4 chunks within a 2,400-token budget
   ├─ build a context-only prompt
   └─ stream answer + source cards over SSE
```

## Requirements

- Node.js 20 or newer.
- PostgreSQL 18 with pgvector 0.8.7.
- llama.cpp with three local model servers:

| Port | Model | Role | Context |
| --- | --- | --- | --- |
| 8080 | Qwen3-Embedding-0.6B-Q8_0 | Embeddings and tokenization | 2,048 tokens |
| 8081 | Qwen3.5-9B-Q4_K_M | Answer generation | 8,192 tokens (`-np 2`) |
| 8082 | Qwen3-Reranker-0.6B-Q6_K | Cross-encoder reranking | 4,096 tokens |

The data export and model files are not included in this repository. `data/` is
git-ignored; the checked-in evaluation scripts assume a local
`data/dota2-wiki.json` export exists. The crawler and upstream normalization
code are not part of this repository.

See [docs/llama-cpp-stack.md](docs/llama-cpp-stack.md) for model conversion,
launchd setup, and llama.cpp pitfalls.

## Quick start

```bash
npm install

# Start PostgreSQL and the three llama.cpp servers, then verify all four ports.
./scripts/service.sh check

# Rebuild chunks only when the source export or chunking logic changes.
# Requires the embedding server because /tokenize is used for exact counts.
npm run chunk

# Embed chunks and write them to PostgreSQL. Safe to rerun.
npm run ingest

# Start the web app at http://127.0.0.1:8787
npm run serve
```

Useful service commands:

```bash
./scripts/service.sh start
./scripts/service.sh status
./scripts/service.sh logs
./scripts/service.sh restart
./scripts/service.sh stop
PORT=9000 ./scripts/service.sh start
```

CLI examples:

```bash
node src/search.mjs "哪些技能不能被驱散"
node src/ask.mjs "弱驱散和强驱散有什么区别？"
RERANK=1 node src/ask.mjs "弱驱散和强驱散有什么区别？"
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | `postgresql://messiah@127.0.0.1:5432/dota2_wiki` | PostgreSQL connection |
| `DOTA2_EMBED_URL` | `http://127.0.0.1:8080` | Embedding and tokenization server |
| `DOTA2_CHAT_URL` | `http://127.0.0.1:8081` | Generation server |
| `DOTA2_RERANK_URL` | `http://127.0.0.1:8082` | Reranker server |
| `RECALL_K` | `20` | Dense candidates retrieved per question |
| `TOP_N` | `4` | Maximum chunks placed in the prompt |
| `CONTEXT_BUDGET` | `2400` | Maximum retrieved-context tokens |
| `MIN_TOKENS` | `60` | Ignore very short chunks during retrieval |
| `PORT` | `8787` | Web server port |
| `HOST` | `127.0.0.1` | Web server bind address |
| `DOTA2_INGEST_CONCURRENCY` | `6` | Concurrent embedding requests during ingestion |
| `RERANK` | unset | CLI-only switch; use `RERANK=1` to rerank |

The web request uses `"rerank": true`; the CLI uses `RERANK=1`.

## HTTP API

### `POST /api/ask`

```bash
curl -N http://127.0.0.1:8787/api/ask \
  -H 'Content-Type: application/json' \
  -d '{"question":"弱驱散和强驱散有什么区别？","rerank":false}'
```

The response is `text/event-stream` with these event types:

| Event | Payload |
| --- | --- |
| `status` | Human-readable progress stage |
| `sources` | Selected chunks, retrieval timing, context token count |
| `delta` | Incremental answer text |
| `done` | End-to-end elapsed time and model usage |
| `error` | Failure message or cancellation |

Questions are limited to 500 characters. The server binds to loopback by
default and has no authentication or rate limiting.

### `GET /health`

Returns the process configuration. This is a liveness check only; it does not
verify PostgreSQL or any model server.

## Data pipeline

### Chunking strategy

| Document type | Strategy | Chunks | Token range |
| --- | --- | --- | --- |
| Hero | One hero per chunk; split only when too long | 129 | 22-1,064 |
| Ability | One ability per chunk; split only when too long | 1,040 | 21-1,674 |
| Mechanism | Split at h2-h4 headings, merge tiny sections, greedily pack | 549 | 59-1,633 |
| **Total** | | **1,718** | **21-1,674** |

Mechanism articles are packed toward 1,000 tokens, with a soft packing ceiling
of 1,800 and the embedding server's 2,048-token hard limit. Every final chunk is
counted with the server's `/tokenize` endpoint. Overflow is an error, not a
silent truncation.

Two details matter more than the headline numbers:

- Sections shorter than 150 characters are merged before packing. Heading-only
  fragments are lexically dense and tend to dominate cosine similarity.
- A chunk header is prepended before embedding so a section carries its entity
  and domain context. Redirect-page names are included as aliases in the target
  chunk header.

The runtime `MIN_TOKENS=60` filter removes 66 tiny chunks from retrieval. They
remain in the database for auditability and possible future re-chunking.

### Incremental ingestion

Each chunk has:

- `chunk_key = doc_type:source_id:chunk_index`, stable across ordinary reruns.
- `content_hash = md5(text)`, used to skip unchanged chunks.
- `metadata`, including source IDs, tags, aliases, and part numbers; the source
  URL is stored separately for citation.

`npm run ingest` only re-embeds chunks whose content changed, removes keys that
no longer exist in `chunks.json`, and verifies that every embedding has 1,024
dimensions. Use `-- --force` to re-embed everything or `-- --reset` to truncate
the table first.

## Storage

The main table is `wiki_chunks`. Important columns:

| Column | Purpose |
| --- | --- |
| `chunk_key` | Primary key and idempotency key |
| `doc_type`, `source_id`, `chunk_index` | Entity and ordering metadata |
| `title`, `heading`, `url` | Citation and UI display |
| `text`, `token_count` | Prompt material and budget accounting |
| `content_hash` | Incremental ingestion |
| `metadata` | Tags, aliases, parts, and other filters |
| `embedding vector(1024)` | Dense retrieval vector |

Indexes:

- HNSW with `vector_cosine_ops` for approximate nearest-neighbor search.
- A composite `(doc_type, source_id)` index for entity lookup.
- A GIN index on `metadata` for future structured filtering.

At 1,718 rows, PostgreSQL may still choose a sequential scan; the HNSW index is
configured for growth rather than to claim that an approximate index is
mandatory at this scale. A trigram index was tried and removed because it had
zero scans and was not part of a hybrid retrieval path.

## Evaluation

### Retrieval evaluation

```bash
npm run eval
npm run eval -- -v
```

`eval/questions.json` contains 18 handwritten questions. A result is a hit when
the expected `(doc_type, title)` pair appears in the retrieved set.

| Pipeline | Hit@1 | Hit@5 | MRR |
| --- | --- | --- | --- |
| Dense only | 83% | 94% | not recorded here |
| Dense + reranker | 94% | 100% | 0.972 |

### Answer evaluation

```bash
npm run eval:answer
npm run eval:answer -- --limit 20
npm run eval:answer -- --types cast,ood
```

The 115-record set contains 30 casting-value questions, 35 special-value
questions, 15 ownership questions, 30 mechanism questions, and 5
out-of-domain questions. The script reports:

- context recall of the gold document;
- MRR of the gold document in the reranked list;
- normalized answer correctness;
- citation hit rate;
- abstention correctness for out-of-domain questions;
- a cheap numeric-support hallucination check.

The evaluation set is generated from the dataset and must pass a grounding
check: the expected answer has to appear verbatim in the gold chunk. This avoids
questions whose answer is absent from the corpus, but it is not a substitute for
human adjudication.

These numbers come from the author's local M1 machine. They are useful as an
engineering baseline, not as a general Dota QA benchmark.

## Design decisions

| Decision | Why |
| --- | --- |
| Local models and local PostgreSQL | No external API dependency; inspectable latency and cost |
| Structured export instead of raw HTML parsing | The upstream export already resolves navigation, placeholders, and forms |
| Entity-aware chunks | Dota answers are usually about one hero, ability, or mechanism; fixed windows break those units |
| Dense retrieval first | The corpus is small, domain-specific, and dense recall is already strong |
| Optional reranker | It improves precision, but is too slow to be the default on this hardware |
| Fail on token overflow | Silent truncation makes content disappear from the index without a visible error |
| PostgreSQL + pgvector | One dependency for metadata, text, and vectors; sufficient for a single small corpus |

## Known limitations

- Dense retrieval only; there is no BM25/trigram hybrid branch or RRF fusion.
- No query rewriting, HyDE, multi-query retrieval, MMR, per-document cap, or
  neighbour expansion.
- No score threshold or adaptive top-k; the fixed 4-chunk/2,400-token budget can
  still include noisy chunks.
- Query-side instruction prefixes recommended by the embedding model are not
  applied by the current runtime; this is a measurable improvement to test.
- Images and diagrams are not indexed, including at least one formula that only
  exists as an image upstream.
- The reranker is slow and runs only on demand.
- Citation markers are generated by the model but are not verified claim by
  claim.
- `eval:answer` uses substring matching and heuristics, not an LLM judge or
  entailment model.
- Ingestion is not atomic; a full rebuild is not zero-downtime.
- There is no query cache, authentication, rate limiting, or CI.
- `/health` does not check database or model dependencies.

### Upstream data caveats

These are source-data issues, not retrieval bugs:

- `傀儡目标` (hero ID 127) has no abilities or biography.
- Three ability Chinese names are truncated upstream:
  `special_bonus_unique_visage_7`, `special_bonus_unique_visage_1`, and
  `special_bonus_unique_faceless_void_4`.
- Tag IDs 454, 644, and 1225 are referenced but missing from the 973-tag table.
- The armor formula is a PNG in the source page, so the text index can only
  support qualitative answers about it.
- Crystal Maiden's `冰川护体` shard relationship is not marked consistently by
  the wiki/Valve datafeed.
- Content images are not indexed; the project notes record 148 such images.

The full interview-oriented analysis, including unused RAG features and the
reasoning behind each omission, is in
[docs/RAG_INTERVIEW_GUIDE.md](docs/RAG_INTERVIEW_GUIDE.md).

## Repository layout

```text
src/
  server.mjs         HTTP server and SSE endpoint
  lib/rag.mjs        retrieval, prompt construction, streaming generation
  lib/paths.mjs      path constants
  chunk.mjs          source export to retrieval chunks
  ingest.mjs         embedding and PostgreSQL ingestion
  search.mjs         retrieval-only CLI
  ask.mjs            end-to-end CLI
  eval.mjs           retrieval evaluation
  eval-answer.mjs    answer-level evaluation
  gen-eval.mjs       grounded evaluation-set generation
  schema.sql         table and index definitions
public/index.html    minimal chat UI
scripts/service.sh   process manager and dependency check
eval/                evaluation sets and generated results
docs/                deployment notes and RAG interview guide
```

## Documentation

- [中文 README](README.zh-CN.md)
- [RAG 面试准备与取舍说明](docs/RAG_INTERVIEW_GUIDE.md)
- [Local llama.cpp stack](docs/llama-cpp-stack.md)
- [Roadmap and TODO](docs/TODO.md)

## Data provenance

The source site is `https://wiki.dota2.com.cn`. The export used here reports game
version `7.41f` and was generated from the site's structured APIs. Dota 2 and
related assets belong to Valve; this repository is a technical RAG experiment,
not an official wiki or game service.

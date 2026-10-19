-- dota2_wiki_rag 的存储结构
-- 依赖：PostgreSQL 18 + pgvector 0.8.7

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS wiki_chunks (
  chunk_key    text PRIMARY KEY,              -- 「doc_type:source_id:part」，重跑幂等
  doc_type     text NOT NULL,                 -- hero | ability | mechanism
  source_id    integer NOT NULL,              -- 对应 dota2-wiki.json 里的主键
  chunk_index  integer NOT NULL,
  title        text NOT NULL,
  heading      text,                          -- 机制文的小节标题
  url          text,                          -- 引用来源
  text         text NOT NULL,
  token_count  integer NOT NULL,
  content_hash text,                          -- 用于增量：内容没变就不重新向量化
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  embedding    vector(1024),                  -- Qwen3-Embedding-0.6B
  embedded_at  timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- 老表补列
ALTER TABLE wiki_chunks ADD COLUMN IF NOT EXISTS content_hash text;

-- 向量检索（1720 行规模下顺序扫描也够快，索引是为后续增量留的）
CREATE INDEX IF NOT EXISTS wiki_chunks_embedding_hnsw
  ON wiki_chunks USING hnsw (embedding vector_cosine_ops);

-- (doc_type, source_id) 的复合索引已能覆盖 doc_type 单列查询，无需再建单列索引
CREATE INDEX IF NOT EXISTS wiki_chunks_source_idx ON wiki_chunks (doc_type, source_id);

-- metadata 过滤：按标签 / 英雄筛选
CREATE INDEX IF NOT EXISTS wiki_chunks_metadata_gin
  ON wiki_chunks USING gin (metadata jsonb_path_ops);

-- 说明：trigram 词面索引（15 MB、当前 0 次使用）已移除。
-- 将来做 RRF 混合检索时再加：
--   CREATE EXTENSION pg_trgm;
--   CREATE INDEX wiki_chunks_text_trgm ON wiki_chunks USING gin (text gin_trgm_ops);

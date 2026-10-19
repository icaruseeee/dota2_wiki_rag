// 把 data/chunks.json 向量化后写入 PostgreSQL。
//
//   npm run ingest              全量写入（按 chunk_key upsert，可重复跑）
//   npm run ingest -- --force   忽略已入库的块，重新向量化
//
// 任何一块超过 embedding 的上下文上限都会直接报错退出，不会静默跳过。

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import pg from 'pg';
import { DATA_DIR, ROOT } from './lib/paths.mjs';

const EMBED_URL = process.env.DOTA2_EMBED_URL || 'http://127.0.0.1:8080';
const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://messiah@127.0.0.1:5432/dota2_wiki';
const CONCURRENCY = Number(process.env.DOTA2_INGEST_CONCURRENCY ?? 6);
const FORCE = process.argv.includes('--force');
const RESET = process.argv.includes('--reset');

const hashOf = (text) => createHash('md5').update(text).digest('hex');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function embed(text, attempt = 0) {
  const res = await fetch(`${EMBED_URL}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: text, model: 'qwen3-embedding' }),
  });
  if (res.status === 400) {
    const body = await res.text();
    throw new Error(`embedding 拒绝该块（长度超限？）：${body.slice(0, 200)}`);
  }
  if (!res.ok) {
    // 5xx 是服务端瞬时错误（本地模型偶尔会因瞬时内存压力报 500），多退避几次
    if (attempt < 5) {
      await sleep(500 * 2 ** attempt);
      return embed(text, attempt + 1);
    }
    throw new Error(`embedding HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  }
  const json = await res.json();
  const vector = json?.data?.[0]?.embedding;
  if (!Array.isArray(vector) || vector.length !== 1024) {
    throw new Error(`embedding 返回异常维度：${vector?.length}`);
  }
  return vector;
}

const toVectorLiteral = (arr) => `[${arr.map((x) => x.toFixed(7)).join(',')}]`;

async function main() {
  const startedAt = Date.now();
  const chunks = JSON.parse(await readFile(join(DATA_DIR, 'chunks.json'), 'utf8'));
  console.log(`待入库块数 ${chunks.length}`);

  // 用连接池：单 client 上并发 query 会被 pg 串行化并在 pg@9 移除
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: CONCURRENCY + 2 });
  const { rows: version } = await pool.query('select version()');
  console.log(`目标库 ${version[0].version.split(',')[0]}`);

  const schema = await readFile(join(ROOT, 'src', 'schema.sql'), 'utf8');
  await pool.query(schema);
  console.log('表结构就绪');

  // 重新切块后 chunk_key 会变，旧块会变成孤儿；重跑时先清空
  if (RESET) {
    await pool.query('TRUNCATE wiki_chunks');
    console.log('已清空 wiki_chunks');
  }

  // 增量：只跳过「key 存在 + 内容哈希一致 + 已有向量」的块
  const existing = new Map();
  if (!FORCE) {
    const { rows } = await pool.query(
      'select chunk_key, content_hash from wiki_chunks where embedding is not null',
    );
    for (const row of rows) existing.set(row.chunk_key, row.content_hash);
  }

  const withHash = chunks.map((c) => ({ ...c, content_hash: hashOf(c.text) }));
  const pending = withHash.filter((c) => existing.get(c.chunk_key) !== c.content_hash);
  const unchanged = withHash.length - pending.length;
  if (unchanged) console.log(`内容未变 ${unchanged} 块，跳过（--force 可强制重算）`);
  let done = 0;
  let cursor = 0;
  const failures = [];
  const t0 = Date.now();

  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (cursor < pending.length) {
        const chunk = pending[cursor++];
        try {
          const vector = await embed(chunk.text);
          await pool.query(
            `insert into wiki_chunks
               (chunk_key, doc_type, source_id, chunk_index, title, heading, url,
                text, token_count, content_hash, metadata, embedding, embedded_at, updated_at)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::vector, now(), now())
             on conflict (chunk_key) do update set
               title = excluded.title,
               heading = excluded.heading,
               url = excluded.url,
               text = excluded.text,
               token_count = excluded.token_count,
               content_hash = excluded.content_hash,
               metadata = excluded.metadata,
               embedding = excluded.embedding,
               embedded_at = now(),
               updated_at = now()`,
            [
              chunk.chunk_key,
              chunk.doc_type,
              chunk.source_id,
              chunk.chunk_index,
              chunk.title,
              chunk.heading,
              chunk.url,
              chunk.text,
              chunk.token_count,
              chunk.content_hash,
              JSON.stringify(chunk.metadata),
              toVectorLiteral(vector),
            ],
          );
          done++;
          if (done % 200 === 0) {
            const rate = done / ((Date.now() - t0) / 1000);
            process.stdout.write(`  已入库 ${done}/${pending.length}  (${rate.toFixed(1)} 块/秒)\r`);
          }
        } catch (err) {
          failures.push({ key: chunk.chunk_key, title: chunk.title, error: err.message });
        }
      }
    }),
  );
  process.stdout.write(' '.repeat(60) + '\r');

  // 重切后不再存在的块要清掉，否则会残留旧内容
  const liveKeys = withHash.map((c) => c.chunk_key);
  const { rowCount: pruned } = await pool.query(
    'delete from wiki_chunks where chunk_key <> all($1::text[])',
    [liveKeys],
  );
  if (pruned) console.log(`清理失效旧块 ${pruned} 条`);

  if (failures.length) {
    console.error(`\n\x1b[31m${failures.length} 块入库失败\x1b[0m`);
    for (const f of failures.slice(0, 8)) console.error(`  ${f.key} ${f.title}: ${f.error}`);
    await pool.end();
    throw new Error('入库未完成');
  }

  const { rows: stats } = await pool.query(
    `select doc_type, count(*) n, min(token_count) min_t, max(token_count) max_t,
            count(embedding) embedded
       from wiki_chunks group by doc_type order by doc_type`,
  );
  console.log('\n库内统计');
  for (const s of stats) {
    console.log(`  ${s.doc_type.padEnd(10)} ${String(s.n).padStart(4)} 块   token ${s.min_t}–${s.max_t}   已向量化 ${s.embedded}`);
  }
  const { rows: total } = await pool.query('select count(*) n from wiki_chunks');
  console.log(`  合计       ${total[0].n} 块`);

  console.log(`\n本次写入 ${done} 块，耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  await pool.end();
}

main().catch((err) => {
  console.error(`\n\x1b[31m${err.message}\x1b[0m`);
  process.exit(1);
});

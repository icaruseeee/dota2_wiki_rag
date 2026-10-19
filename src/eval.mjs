// 用一批真实问题评测检索质量：向量检索 vs 向量检索 + 重排。
//
//   npm run eval            跑整套
//   npm run eval -- -v      打印每个问题的命中详情
//
// 指标：Hit@1 / Hit@5 / MRR@10。命中判定 = top-k 里出现任一期望文档。

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { ROOT } from './lib/paths.mjs';

const EMBED_URL = process.env.DOTA2_EMBED_URL || 'http://127.0.0.1:8080';
const RERANK_URL = process.env.DOTA2_RERANK_URL || 'http://127.0.0.1:8082';
const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://messiah@127.0.0.1:5432/dota2_wiki';
const RECALL_K = 20; // 向量召回数量，也是重排候选数
const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
// 过短的碎块会靠用词重合挤掉真正有内容的块，检索时先过滤掉
const MIN_TOKENS = Number(process.env.MIN_TOKENS ?? 60);

async function embed(text) {
  const res = await fetch(`${EMBED_URL}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: text, model: 'qwen3-embedding' }),
  });
  if (!res.ok) throw new Error(`embedding ${res.status}`);
  return (await res.json()).data[0].embedding;
}

async function rerank(query, documents) {
  const res = await fetch(`${RERANK_URL}/v1/rerank`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'qwen3-reranker', query, documents }),
  });
  if (!res.ok) throw new Error(`rerank ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const json = await res.json();
  // results 已按相关性降序，但 index 指向原数组
  return json.results.map((r) => r.index);
}

/** 命中：doc_type 匹配且 title 匹配任一正则 */
function isHit(row, expect) {
  return expect.some(([type, pattern]) => {
    if (row.doc_type !== type) return false;
    return new RegExp(pattern).test(row.title);
  });
}

function rankOf(rows, expect) {
  const i = rows.findIndex((row) => isHit(row, expect));
  return i < 0 ? null : i + 1;
}

function summarize(name, results) {
  const n = results.length;
  const hit1 = results.filter((r) => r.rank === 1).length;
  const hit5 = results.filter((r) => r.rank !== null && r.rank <= 5).length;
  const hit10 = results.filter((r) => r.rank !== null && r.rank <= 10).length;
  const mrr = results.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / n;
  console.log(
    `  ${name.padEnd(14)} Hit@1 ${String(hit1).padStart(2)}/${n} (${((100 * hit1) / n).toFixed(0)}%)` +
      `   Hit@5 ${String(hit5).padStart(2)}/${n} (${((100 * hit5) / n).toFixed(0)}%)` +
      `   Hit@10 ${String(hit10).padStart(2)}/${n}   MRR ${mrr.toFixed(3)}`,
  );
  return { hit1, hit5, hit10, mrr, n };
}

async function main() {
  const startedAt = Date.now();
  const questions = JSON.parse(await readFile(join(ROOT, 'eval', 'questions.json'), 'utf8'));
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  console.log(`问题数 ${questions.length}，向量召回 top ${RECALL_K}\n`);

  const vecRanks = [];
  const rrRanks = [];
  const detail = [];

  for (const item of questions) {
    const vector = await embed(item.q);
    const literal = `[${vector.map((x) => x.toFixed(7)).join(',')}]`;
    const { rows } = await pool.query(
      `select chunk_key, doc_type, title, heading, text,
              round((1 - (embedding <=> $1::vector))::numeric, 4) as sim
         from wiki_chunks
        where embedding is not null
          and token_count >= $3
        order by embedding <=> $1::vector
        limit $2`,
      [literal, RECALL_K, MIN_TOKENS],
    );

    const vecRank = rankOf(rows, item.expect);
    let rrRank = null;
    try {
      const order = await rerank(item.q, rows.map((r) => r.text));
      const reranked = order.map((i) => rows[i]);
      rrRank = rankOf(reranked, item.expect);
      if (VERBOSE) {
        detail.push({ item, rows, reranked, vecRank, rrRank });
      }
    } catch (err) {
      console.error(`  重排失败 ${item.id}: ${err.message}`);
    }

    vecRanks.push({ rank: vecRank });
    rrRanks.push({ rank: rrRank });
    if (!VERBOSE) {
      const mark = vecRank === 1 && rrRank === 1 ? '\x1b[32m✓\x1b[0m' : vecRank || rrRank ? '\x1b[33m~\x1b[0m' : '\x1b[31m✗\x1b[0m';
      console.log(
        `  ${mark} ${item.id}  向量#${vecRank ?? '-'}  重排#${rrRank ?? '-'}  ${item.q}`,
      );
    }
  }

  console.log('\n汇总');
  summarize('向量检索', vecRanks);
  summarize('+ 重排', rrRanks);

  if (VERBOSE) {
    for (const d of detail) {
      console.log(`\n--- ${d.item.id} ${d.item.q}`);
      console.log(`    期望: ${JSON.stringify(d.item.expect)}`);
      console.log(`    向量前 5: ${d.rows.slice(0, 5).map((r) => `[${r.doc_type}]${r.title}/${r.sim}`).join('  ')}`);
      console.log(`    重排前 5: ${d.reranked.slice(0, 5).map((r) => `[${r.doc_type}]${r.title}`).join('  ')}`);
      if (d.vecRank === null && d.rrRank === null) {
        console.log(`    \x1b[31m召回里就没有期望文档\x1b[0m`);
      }
    }
  }

  await pool.end();
  console.log(`\n耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

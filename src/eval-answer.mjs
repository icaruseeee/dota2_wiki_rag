// 答案级评测：检索召回 + 重排 + 生成，逐题打分。
//
//   npm run eval:answer                    跑全部（113 题，约 2 小时，9B 很慢）
//   npm run eval:answer -- --limit 20      只跑前 20 题
//   npm run eval:answer -- --types cast,ood
//
// 指标：
//   recall@N  取进 context 的块里是否有金标块
//   MRR       金标块在重排结果里的倒数排名
//   answer    标准答案是否出现在生成的回答里
//   citation  回答引用的块里是否有金标块
//   abstain   OOD 题是否正确拒答
//   numbers   回答里的数字是否都能在 context 里找到（廉价的幻觉检查）

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { DATA_DIR, ROOT } from './lib/paths.mjs';

const EMBED_URL = process.env.DOTA2_EMBED_URL || 'http://127.0.0.1:8080';
const RERANK_URL = process.env.DOTA2_RERANK_URL || 'http://127.0.0.1:8082';
const CHAT_URL = process.env.DOTA2_CHAT_URL || 'http://127.0.0.1:8081';
const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://messiah@127.0.0.1:5432/dota2_wiki';

const RECALL_K = Number(process.env.RECALL_K ?? 20);
const TOP_N = Number(process.env.TOP_N ?? 4);
const CONTEXT_BUDGET = Number(process.env.CONTEXT_BUDGET ?? 2400);
const MIN_TOKENS = Number(process.env.MIN_TOKENS ?? 60);

const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};
const LIMIT = Number(argOf('--limit') ?? 0);
const TYPES = argOf('--types')?.split(',').map((s) => s.trim());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 归一化：去空白、去标点、统一斜杠与逗号，便于宽松比对 */
const norm = (s) =>
  String(s ?? '')
    .replace(/[\s\u00a0]+/g, '')
    .replace(/[，。；：、（）()]/g, '')
    .replace(/\//g, '')
    .toLowerCase();

const numbersIn = (s) => (String(s ?? '').match(/\d+(?:\.\d+)?/g) ?? []).filter((n) => n.length <= 6);

async function embed(text) {
  const res = await fetch(`${EMBED_URL}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: text, model: 'qwen3-embedding' }),
  });
  if (!res.ok) throw new Error(`embedding ${res.status}`);
  return (await res.json()).data[0].embedding;
}

async function rerank(query, documents, attempt = 0) {
  const res = await fetch(`${RERANK_URL}/v1/rerank`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'qwen3-reranker', query, documents }),
  });
  if (!res.ok) {
    if (attempt < 3) {
      await sleep(500 * 2 ** attempt);
      return rerank(query, documents, attempt + 1);
    }
    throw new Error(`rerank ${res.status}`);
  }
  return (await res.json()).results;
}

async function chat(messages, attempt = 0) {
  const res = await fetch(`${CHAT_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'qwen3.5-9b',
      messages,
      max_tokens: 400,
      temperature: 0.2,
      chat_template_kwargs: { enable_thinking: false },
    }),
  });
  if (!res.ok) {
    if (attempt < 3) {
      await sleep(800 * 2 ** attempt);
      return chat(messages, attempt + 1);
    }
    throw new Error(`chat ${res.status}`);
  }
  const json = await res.json();
  return json.choices?.[0]?.message?.content ?? '';
}

function buildPrompt(question, sources) {
  const material = sources.map((s, i) => `[${i + 1}] 《${s.title}》\n${s.text}`).join('\n\n');
  return [
    '你是《Dota 2》中文 wiki 助手。下面是检索到的资料，编号 [1]、[2]…',
    '只依据资料回答，不要补充资料之外的知识；资料不足时直接说「资料中没有提到」。',
    '回答时在句末标注来源编号。',
    '',
    '资料：',
    material,
    '',
    `问题：${question}`,
  ].join('\n');
}

const pool = new pg.Pool({ connectionString: DATABASE_URL });

async function runOne(item) {
  const vector = await embed(item.question);
  const literal = `[${vector.map((x) => x.toFixed(7)).join(',')}]`;
  const { rows } = await pool.query(
    `select chunk_key, doc_type, source_id, title, text, token_count
       from wiki_chunks
      where embedding is not null and token_count >= $3
      order by embedding <=> $1::vector
      limit $2`,
    [literal, RECALL_K, MIN_TOKENS],
  );
  const ranked = await rerank(item.question, rows.map((r) => r.text));
  const reranked = ranked.map((r) => rows[r.index]);

  const picked = [];
  let used = 0;
  for (const row of reranked) {
    if (picked.length >= TOP_N) break;
    if (used + row.token_count > CONTEXT_BUDGET) continue;
    picked.push(row);
    used += row.token_count;
  }

  const answer = await chat([{ role: 'user', content: buildPrompt(item.question, picked) }]);

  // ---- 打分 ----
  // 金标按 (doc_type, source_id) + 答案原文判定，重切后 chunk_key 变了也不影响
  const isGold = (row) =>
    Boolean(item.gold_doc) &&
    row.doc_type === item.gold_doc.doc_type &&
    row.source_id === item.gold_doc.source_id &&
    norm(row.text).includes(norm(item.answer));
  const rank = reranked.findIndex(isGold) + 1;
  const recall = picked.some(isGold);

  const cited = [...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]) - 1);
  const citationHit = cited.some((i) => picked[i] && isGold(picked[i]));

  let correct = null;
  if (item.type === 'ood') {
    correct = /没有|未提及|无法|不包含|不知道|不清楚|资料中不/.test(answer);
  } else if (item.answer) {
    correct = norm(answer).includes(norm(item.answer));
  }

  const context = picked.map((p) => p.text).join('\n');
  const ctxNorm = norm(context);
  const badNumbers = numbersIn(answer).filter((n) => !ctxNorm.includes(n));

  return {
    id: item.id,
    type: item.type,
    question: item.question,
    expected: item.answer,
    answer,
    rank: rank || null,
    recall,
    citation_hit: citationHit,
    correct,
    bad_numbers: badNumbers,
    picked: picked.map((p) => ({ key: p.chunk_key, title: p.title })),
  };
}

async function main() {
  let items = (await readFile(join(ROOT, 'eval', 'qa.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  if (TYPES) items = items.filter((i) => TYPES.includes(i.type));
  if (LIMIT) items = items.slice(0, LIMIT);

  console.log(`评测 ${items.length} 题\n`);
  const results = [];
  for (const [i, item] of items.entries()) {
    try {
      const r = await runOne(item);
      results.push(r);
      const mark = r.correct === true ? '\x1b[32m✓\x1b[0m' : r.correct === false ? '\x1b[31m✗\x1b[0m' : '\x1b[33m?\x1b[0m';
      console.log(
        `  ${mark} [${i + 1}/${items.length}] ${item.type.padEnd(10)} rank=${r.rank ?? '-'} ${item.question.slice(0, 40)}`,
      );
    } catch (err) {
      console.log(`  \x1b[31m!\x1b[0m [${i + 1}/${items.length}] ${item.question.slice(0, 40)}  ${err.message}`);
    }
  }

  const byType = {};
  for (const r of results) (byType[r.type] ??= []).push(r);

  console.log('\n类型        n   召回@N   MRR    答案正确   引用命中   数字幻觉');
  const all = [];
  for (const [type, arr] of Object.entries(byType)) {
    all.push(...arr);
    const n = arr.length;
    const recall = arr.filter((r) => r.recall).length / n;
    const mrr = arr.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / n;
    const graded = arr.filter((r) => r.correct !== null);
    const correct = graded.length ? graded.filter((r) => r.correct).length / graded.length : NaN;
    const cit = arr.filter((r) => r.citation_hit).length / n;
    const bad = arr.reduce((s, r) => s + r.bad_numbers.length, 0);
    console.log(
      `  ${type.padEnd(10)} ${String(n).padStart(3)}  ${(recall * 100).toFixed(0).padStart(5)}%  ${mrr.toFixed(3)}  ` +
        `${Number.isNaN(correct) ? '  -  ' : `${(correct * 100).toFixed(0).padStart(6)}%`}  ${(cit * 100).toFixed(0).padStart(7)}%  ${String(bad).padStart(7)}`,
    );
  }
  const n = all.length;
  const graded = all.filter((r) => r.correct !== null);
  console.log(
    `  ${'合计'.padEnd(10)} ${String(n).padStart(3)}  ${((all.filter((r) => r.recall).length / n) * 100).toFixed(0).padStart(5)}%  ` +
      `${(all.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / n).toFixed(3)}  ` +
      `${((graded.filter((r) => r.correct).length / graded.length) * 100).toFixed(0).padStart(6)}%  ` +
      `${((all.filter((r) => r.citation_hit).length / n) * 100).toFixed(0).padStart(7)}%  ${String(all.reduce((s, r) => s + r.bad_numbers.length, 0)).padStart(7)}`,
  );

  const out = join(DATA_DIR, '..', 'eval', `results-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.jsonl`);
  await writeFile(out, `${results.map((r) => JSON.stringify(r)).join('\n')}\n`);
  console.log(`\n明细 ${out}`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// 端到端问答 CLI：向量召回 → 重排 → 取块 → 交给 9B 生成 → 带出处输出
//
//   node src/ask.mjs "弱驱散和强驱散有什么区别？"
//   node src/ask.mjs --batch eval/demo-questions.json
//   node src/ask.mjs --batch eval/qa.jsonl       直接跑评测集的题面
//   RERANK=1 node src/ask.mjs "…"                走精排（慢）

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT } from './lib/paths.mjs';
import { buildPrompt, closePool, retrieve, streamAnswer } from './lib/rag.mjs';

const useRerank = process.env.RERANK === '1';

async function ask(question, index, total) {
  const startedAt = Date.now();
  const { sources, tokens } = await retrieve(question, { rerank: useRerank });

  let text = '';
  const usage = await streamAnswer(buildPrompt(question, sources), (delta) => {
    text += delta;
  });
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);

  console.log(`\n${'='.repeat(78)}`);
  console.log(`[${index}/${total}] ${question}`);
  console.log(`\n来源（${sources.length} 块，${tokens} token${useRerank ? '，已精排' : ''}）:`);
  for (const [i, s] of sources.entries()) {
    console.log(
      `  [${i + 1}] [${s.doc_type}] ${s.title}${s.heading ? ` · ${s.heading}` : ''}  (${s.token_count} tok)`,
    );
  }
  console.log(
    `\n回答（prompt ${usage?.prompt_tokens ?? '-'} tok / 生成 ${usage?.completion_tokens ?? '-'} tok / ${elapsed}s）:\n`,
  );
  console.log(text.trim() || '\x1b[31m(空回答)\x1b[0m');
}

const args = process.argv.slice(2);
const batchIndex = args.indexOf('--batch');
let questions;
if (batchIndex >= 0) {
  const file = args[batchIndex + 1];
  const raw = await readFile(join(ROOT, file), 'utf8');
  questions = file.endsWith('.jsonl')
    ? raw.split('\n').filter(Boolean).map((line) => JSON.parse(line).question)
    : JSON.parse(raw);
} else {
  questions = [args.join(' ') || '弱驱散和强驱散有什么区别？'];
}

for (const [i, q] of questions.entries()) {
  try {
    await ask(q, i + 1, questions.length);
  } catch (err) {
    console.log(`\n[${i + 1}/${questions.length}] ${q}\n\x1b[31m失败: ${err.message}\x1b[0m`);
  }
}

await closePool();

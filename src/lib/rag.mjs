// 检索 + 生成的可复用实现，供服务端与 CLI 共用。

import pg from 'pg';

const EMBED_URL = process.env.DOTA2_EMBED_URL || 'http://127.0.0.1:8080';
const RERANK_URL = process.env.DOTA2_RERANK_URL || 'http://127.0.0.1:8082';
const CHAT_URL = process.env.DOTA2_CHAT_URL || 'http://127.0.0.1:8081';
const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://messiah@127.0.0.1:5432/dota2_wiki';

export const config = {
  recallK: Number(process.env.RECALL_K ?? 20),
  topN: Number(process.env.TOP_N ?? 4),
  contextBudget: Number(process.env.CONTEXT_BUDGET ?? 2400),
  minTokens: Number(process.env.MIN_TOKENS ?? 60),
};

const pool = new pg.Pool({ connectionString: DATABASE_URL });
export const closePool = () => pool.end();

async function embed(text) {
  const res = await fetch(`${EMBED_URL}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: text, model: 'qwen3-embedding' }),
  });
  if (!res.ok) throw new Error(`embedding ${res.status}: ${(await res.text()).slice(0, 120)}`);
  return (await res.json()).data[0].embedding;
}

async function rerank(query, documents) {
  const res = await fetch(`${RERANK_URL}/v1/rerank`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'qwen3-reranker', query, documents }),
  });
  if (!res.ok) throw new Error(`rerank ${res.status}: ${(await res.text()).slice(0, 120)}`);
  return (await res.json()).results;
}

/**
 * 向量召回 → 重排 → 按 token 预算取块
 * onProgress(stage, ms) 用于把阶段进度推给前端。
 */
export async function retrieve(question, { rerank: useRerank = true, onProgress = () => {} } = {}) {
  const t0 = Date.now();
  const vector = await embed(question);
  onProgress('embed', Date.now() - t0);

  const t1 = Date.now();
  const literal = `[${vector.map((x) => x.toFixed(7)).join(',')}]`;
  const { rows } = await pool.query(
    `select chunk_key, doc_type, title, heading, url, text, token_count
       from wiki_chunks
      where embedding is not null and token_count >= $3
      order by embedding <=> $1::vector
      limit $2`,
    [literal, config.recallK, config.minTokens],
  );
  onProgress('recall', Date.now() - t1);

  const t2 = Date.now();
  // 精排很准但很慢：这台 M1 上 20 篇要 20–50 秒，交互场景默认关掉
  let ranked = rows.map((row, index) => ({ index, relevance_score: 1 - index / rows.length }));
  if (useRerank) ranked = await rerank(question, rows.map((r) => r.text));
  onProgress('rerank', Date.now() - t2);

  const picked = [];
  let used = 0;
  for (const item of ranked) {
    if (picked.length >= config.topN) break;
    const row = rows[item.index];
    if (used + row.token_count > config.contextBudget) continue;
    picked.push({ ...row, score: item.relevance_score });
    used += row.token_count;
  }
  return {
    sources: picked,
    tokens: used,
    timings: {
      embed: t1 - t0,
      recall: t2 - t1,
      rerank: Date.now() - t2,
      total: Date.now() - t0,
    },
  };
}

export function buildPrompt(question, sources) {
  const material = sources
    .map((s, i) => `[${i + 1}] 《${s.title}》${s.heading ? ` · ${s.heading}` : ''}\n${s.text}`)
    .join('\n\n');
  return [
    '你是《Dota 2》中文 wiki 助手。下面是检索到的资料，编号 [1]、[2]…',
    '',
    '要求：',
    '1. 只依据资料回答，不要补充资料之外的知识。',
    '2. 资料不足以回答时，直接说「资料中没有提到」，不要猜测。',
    '3. 引用具体条目时在句末标注来源编号，例如 [1]。',
    '4. 用简洁的中文回答。',
    '',
    '资料：',
    material,
    '',
    `问题：${question}`,
  ].join('\n');
}

/** 流式生成；每拿到一段文本调用 onDelta */
export async function streamAnswer(prompt, onDelta, signal) {
  const res = await fetch(`${CHAT_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      model: 'qwen3.5-9b',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 600,
      temperature: 0.3,
      stream: true,
      stream_options: { include_usage: true },
      // thinking 模型：不关的话 token 全被思维链吃掉，正文为空
      chat_template_kwargs: { enable_thinking: false },
    }),
  });
  if (!res.ok) throw new Error(`chat ${res.status}: ${(await res.text()).slice(0, 160)}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let usage = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') return usage;
      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      if (json.usage) usage = json.usage;
      const delta = json.choices?.[0]?.delta?.content;
      if (delta) onDelta(delta);
    }
  }
  return usage;
}

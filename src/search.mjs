// 向量检索验证：
//   node src/search.mjs "哪些技能不能被驱散"

import pg from 'pg';

const EMBED_URL = process.env.DOTA2_EMBED_URL || 'http://127.0.0.1:8080';
const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://messiah@127.0.0.1:5432/dota2_wiki';

async function embed(text) {
  const res = await fetch(`${EMBED_URL}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: text, model: 'qwen3-embedding' }),
  });
  if (!res.ok) throw new Error(`embedding ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).data[0].embedding;
}

const query = process.argv.slice(2).join(' ') || '弱驱散和强驱散有什么区别';
const topK = Number(process.env.TOP_K ?? 8);
// 过滤过短的碎块：这类块用词密集、余弦相似度天然偏高，会挤占真正有内容的块
const MIN_TOKENS = Number(process.env.MIN_TOKENS ?? 60);

const vector = await embed(query);
const literal = `[${vector.map((x) => x.toFixed(7)).join(',')}]`;

const pool = new pg.Pool({ connectionString: DATABASE_URL });
const { rows } = await pool.query(
  `select chunk_key, doc_type, title, heading, url, token_count,
          round((1 - (embedding <=> $1::vector))::numeric, 4) as cosine_sim,
          left(regexp_replace(text, E'[\\n\\r]+', ' ', 'g'), 110) as preview
     from wiki_chunks
    where embedding is not null
      and token_count >= $3
    order by embedding <=> $1::vector
    limit $2`,
  [literal, topK, MIN_TOKENS],
);
await pool.end();

console.log(`查询：${query}\n`);
for (const [i, r] of rows.entries()) {
  console.log(
    `${String(i + 1).padStart(2)}. ${r.cosine_sim}  [${r.doc_type}] ${r.title}${r.heading ? ` · ${r.heading}` : ''}  (${r.token_count} tok)`,
  );
  console.log(`    ${r.preview}…`);
}

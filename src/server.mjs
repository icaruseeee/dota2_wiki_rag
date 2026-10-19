// 极简对话服务：静态页 + SSE 流式问答。
//
//   npm run serve            http://127.0.0.1:8787
//   PORT=9000 npm run serve

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePool, config, buildPrompt, retrieve, streamAnswer } from './lib/rag.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readBody(req, limit = 32 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function handleAsk(req, res) {
  let question;
  let useRerank = false;
  try {
    const body = JSON.parse(await readBody(req));
    question = String(body.question ?? '').trim();
    useRerank = body.rerank === true;
  } catch (err) {
    return json(res, 400, { error: err.message });
  }
  if (!question) return json(res, 400, { error: 'question 不能为空' });
  if (question.length > 500) return json(res, 400, { error: '问题过长（上限 500 字）' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (obj) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };

  const controller = new AbortController();
  let closed = false;
  req.on('close', () => {
    closed = true;
    controller.abort();
  });

  const startedAt = Date.now();
  try {
    send({ type: 'status', text: '准备中…' });
    const { sources, tokens, timings } = await retrieve(question, {
      rerank: useRerank,
      onProgress: (stage, ms) => {
        if (stage === 'embed') send({ type: 'status', text: '向量召回…' });
        if (stage === 'recall') {
          send({ type: 'status', text: useRerank ? `精排中…（${config.recallK} 候选）` : '选取片段…' });
        }
        if (stage === 'rerank' && useRerank) {
          send({ type: 'status', text: `精排完成（${(ms / 1000).toFixed(1)}s）` });
        }
      },
    });
    if (closed) return;
    const elapsedRetrieval = ((Date.now() - startedAt) / 1000).toFixed(1);

    send({
      type: 'sources',
      retrieval_seconds: Number(elapsedRetrieval),
      context_tokens: tokens,
      timings,
      reranked: useRerank,
      sources: sources.map((s, i) => ({
        index: i + 1,
        doc_type: s.doc_type,
        title: s.title,
        heading: s.heading,
        url: s.url,
        token_count: s.token_count,
        score: Number(s.score?.toFixed(4) ?? 0),
      })),
    });

    send({ type: 'status', text: '生成中…' });
    const usage = await streamAnswer(
      buildPrompt(question, sources),
      (text) => send({ type: 'delta', text }),
      controller.signal,
    );
    if (closed) return;
    send({
      type: 'done',
      elapsed_seconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
      usage,
    });
  } catch (err) {
    if (!closed) send({ type: 'error', message: err.name === 'AbortError' ? '已取消' : err.message });
  } finally {
    if (!res.writableEnded) res.end();
  }
}

async function serveStatic(req, res, pathname) {
  const name = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  if (name.includes('..')) return json(res, 400, { error: '非法路径' });
  try {
    const file = await readFile(join(ROOT, 'public', name));
    const ext = name.slice(name.lastIndexOf('.'));
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(file);
  } catch {
    json(res, 404, { error: 'Not Found' });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (req.method === 'POST' && url.pathname === '/api/ask') return handleAsk(req, res);
  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, { ok: true, config });
  }
  if (req.method === 'GET') return serveStatic(req, res, url.pathname);
  return json(res, 405, { error: 'Method Not Allowed' });
});

server.requestTimeout = 0; // 生成可能超过默认超时
server.listen(PORT, HOST, () => {
  console.log(`dota2 wiki rag  →  http://${HOST}:${PORT}`);
  console.log(`召回 ${config.recallK} / 取块 ${config.topN} / 上下文预算 ${config.contextBudget} token`);
  // 预热 embedding（rerank 是可选路径，首次开启时会多花十几秒编译 kernel）
  setTimeout(async () => {
    const t = Date.now();
    try {
      await retrieve('预热', { rerank: false });
      console.log(`预热完成 ${((Date.now() - t) / 1000).toFixed(1)}s`);
    } catch (err) {
      console.warn(`预热失败（忽略）: ${err.message}`);
    }
  }, 100);
});

const shutdown = async () => {
  server.close();
  await closePool();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

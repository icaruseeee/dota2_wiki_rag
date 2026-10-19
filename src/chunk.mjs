// 把 data/dota2-wiki.json 切成面向检索的块，产出 data/chunks.json。
//
// 切块依据是 :8080 embedding 服务的硬约束 —— 上下文 2048 token，超出直接返回 400
// （不是静默截断），所以任何一块超限都会在入库时丢掉。这里用服务自己的 /tokenize
// 做精确计数，不靠字符数估算。
//
// 粒度是「一实体一块」，不是按字数硬切：
//   英雄 / 技能  实测最大 1093 / 1816 token，一篇一块就够，切了反而伤上下文
//   机制文章     最大 40821 token，按 h2/h3 语义边界切，再贪心合并到目标大小
//
//   npm run chunk

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR } from './lib/paths.mjs';

const EMBED_URL = process.env.DOTA2_EMBED_URL || 'http://127.0.0.1:8080';
const TOKEN_LIMIT = 2048; // 服务端硬限
const MAX_TOKENS = 1800; // 留 248 token 余量
const TARGET_TOKENS = 1000; // 合并时的目标
const CHARS_PER_TOKEN = 0.68; // 实测 0.55-0.74，取偏保守值用于预排布

const estimate = (text) => Math.ceil(text.length * CHARS_PER_TOKEN);

async function countTokens(text) {
  const res = await fetch(`${EMBED_URL}/tokenize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: text }),
  });
  if (!res.ok) throw new Error(`tokenize failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  if (!Array.isArray(json.tokens)) throw new Error(`tokenize 返回异常: ${JSON.stringify(json).slice(0, 200)}`);
  return json.tokens.length;
}

const trim = (s) => String(s ?? '').replace(/\n{3,}/g, '\n\n').trim();

/** 把一段文本按空行/句号拆成可重组的片段 */
function splitBlocks(text, depth = 0) {
  const byParagraph = text.split(/\n{2,}/).map(trim).filter(Boolean);
  if (byParagraph.length > 1) return byParagraph;
  if (depth >= 2) {
    // 最后兜底：按句号切
    const bySentence = text.split(/(?<=[。！？；])/).map(trim).filter(Boolean);
    return bySentence.length > 1 ? bySentence : [text];
  }
  const byLine = text.split(/\n/).map(trim).filter(Boolean);
  if (byLine.length > 1) return byLine;
  const bySentence = text.split(/(?<=[。！？；])/).map(trim).filter(Boolean);
  return bySentence.length > 1 ? bySentence : [text];
}

/**
 * 贪心把若干片段装进不超过 target 的块里，每块都带上 header（标题上下文）。
 * 若单个片段本身就装不下，递归再拆。
 */
function packBlocks(blocks, header) {
  const chunks = [];
  let current = [];
  let currentTokens = estimate(header);

  const flush = () => {
    if (current.length) {
      chunks.push(`${header}\n\n${current.join('\n\n')}`);
      current = [];
      currentTokens = estimate(header);
    }
  };

  const push = (block, depth = 0) => {
    const cost = estimate(block);
    if (cost + estimate(header) > MAX_TOKENS && depth < 3) {
      flush();
      const parts = splitBlocks(block, depth);
      if (parts.length > 1) {
        for (const part of parts) push(part, depth + 1);
        return;
      }
      // 无法再拆：按字符硬切，避免整块超出上限
      const budgetChars = Math.floor((MAX_TOKENS - estimate(header) - 16) / CHARS_PER_TOKEN);
      for (let i = 0; i < block.length; i += budgetChars) {
        chunks.push(`${header}\n\n${block.slice(i, i + budgetChars)}`);
      }
      return;
    }
    if (currentTokens + cost > TARGET_TOKENS) flush();
    current.push(block);
    currentTokens += cost;
  };

  for (const block of blocks) push(block);
  flush();
  return chunks;
}

function buildHeroDocs(heroes) {
  const out = [];
  for (const hero of heroes) {
    const header = `英雄：${hero.name_zh}（${hero.name_english_loc ?? hero.name_en}）· ${hero.team_zh ?? ''} · ${hero.stats.attribute_primary ?? ''} · ${hero.stats.attack_capabilities ?? ''}`;
    const body = [
      hero.intro.bio ? `## 背景\n${hero.intro.bio}` : '',
      hero.intro.lore ? `## 简介\n${hero.intro.lore}` : '',
      hero.intro.hype ? `## 玩法\n${hero.intro.hype}` : '',
      hero.talents.length
        ? `## 天赋\n${hero.talents.map((t) => `- ${t.name_zh}`).join('\n')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    out.push({
      doc_type: 'hero',
      source_id: hero.hero_id,
      title: hero.name_zh,
      url: hero.url,
      header,
      body,
      metadata: {
        slug: hero.slug,
        team: hero.team_zh,
        attribute_primary: hero.stats.attribute_primary,
        attack_capabilities: hero.stats.attack_capabilities,
        ability_ids: hero.ability_ids,
      },
    });
  }
  return out;
}

function buildAbilityDocs(abilities, heroById) {
  const out = [];
  for (const ability of abilities) {
    const heroNames = ability.hero_ids.map((id) => heroById.get(id)?.name_zh).filter(Boolean);
    const header = [
      `技能：${ability.name_zh}（${ability.name_en}）`,
      heroNames.length ? `归属英雄：${heroNames.join('、')}` : '',
      ability.cast.mana_cost || ability.cast.cooldown || ability.cast.cast_range
        ? `施法：${[
            ability.cast.mana_cost && `魔法消耗 ${ability.cast.mana_cost}`,
            ability.cast.cooldown && `冷却 ${ability.cast.cooldown}`,
            ability.cast.cast_range && `施法距离 ${ability.cast.cast_range}`,
          ]
            .filter(Boolean)
            .join(' · ')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n');

    const values = ability.special_values
      .filter((v) => v.show && v.value)
      .map((v) => `- ${v.label}：${v.value}`)
      .join('\n');

    const body = [
      ability.description ? `## 描述\n${ability.description}` : '',
      ability.notes ? `## 机制说明\n${ability.notes}` : '',
      values ? `## 数值\n${values}` : '',
      ability.scepter_description ? `## 神杖升级\n${ability.scepter_description}` : '',
      ability.shard_description ? `## 魔晶升级\n${ability.shard_description}` : '',
      ability.mechanics.length
        ? `## 相关机制\n${ability.mechanics.map((m) => `- ${m.tag.name ?? ''}：${m.note}`).join('\n')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    out.push({
      doc_type: 'ability',
      source_id: ability.id,
      title: ability.name_zh,
      url: ability.url,
      header,
      body,
      metadata: {
        name_en: ability.name_en,
        hero_ids: ability.hero_ids,
        hero_slugs: ability.hero_slugs,
        tags: ability.tags.map((t) => t.name).filter(Boolean),
        mechanics: ability.mechanics.map((m) => m.tag.name).filter(Boolean),
      },
    });
  }
  return out;
}

function buildMechanismDocs(mechanisms) {
  const out = [];
  // 跳转桩没有正文，索引它只会挤占用词相近的真内容；改成给目标页加别名
  const aliases = new Map();
  for (const mech of mechanisms) {
    for (const target of mech.redirect_to ?? []) {
      if (!aliases.has(target)) aliases.set(target, []);
      aliases.get(target).push(mech.name);
    }
  }

  for (const mech of mechanisms) {
    if (mech.redirect_to?.length) continue;
    const aliasNames = aliases.get(mech.name) ?? [];
    out.push({
      doc_type: 'mechanism',
      source_id: mech.id,
      title: mech.name,
      url: mech.url,
      header: aliasNames.length
        ? `机制：${mech.name}（站内跳转页：${aliasNames.join('、')}）`
        : `机制：${mech.name}`,
      body: mech.markdown,
      metadata: {
        tags: mech.tags.map((t) => t.name).filter(Boolean),
        form_ids: mech.form_ids,
        aliases: aliasNames,
      },
    });
  }
  return out;
}

/**
 * 统一打包：先按语义边界拆成片段，再贪心合并到目标大小。
 * 技能/英雄多数一篇一块，只有超长的才会被拆开；机制文一定会拆。
 */
/**
 * 合并过短片段。
 * 按 h2-h4 切分会切出大量「标题 + 一句话」的引导小节（全库 300+ 个），
 * 这类碎片用词密集、余弦相似度天然偏高，会把真正有内容的块挤出前面。
 * 所以短于阈值的片段向后并入下一节。
 */
function mergeTinyBlocks(blocks, minChars = 150) {
  const out = [];
  let carry = '';
  for (const block of blocks) {
    const merged = carry ? `${carry}\n\n${block}` : block;
    if (merged.replace(/\s/g, '').length < minChars) {
      carry = merged;
      continue;
    }
    out.push(merged);
    carry = '';
  }
  if (carry) {
    if (out.length) out[out.length - 1] = `${out[out.length - 1]}\n\n${carry}`;
    else out.push(carry);
  }
  return out;
}

function buildChunks(doc) {
  // 机制文按 h2-h4 切；其它类型按空行切
  const rawBlocks =
    doc.doc_type === 'mechanism'
      ? doc.body.split(/\n(?=#{2,4} )/).map(trim).filter(Boolean)
      : splitBlocks(doc.body);
  const blocks = doc.doc_type === 'mechanism' ? mergeTinyBlocks(rawBlocks) : rawBlocks;
  const pieces = packBlocks(blocks.length ? blocks : [doc.body], doc.header);
  return pieces.map((text, index) => ({
    doc_type: doc.doc_type,
    source_id: doc.source_id,
    title: doc.title,
    heading: doc.doc_type === 'mechanism' ? (text.match(/^#{2,4} (.+)$/m)?.[1] ?? null) : null,
    url: doc.url,
    text,
    metadata: { ...doc.metadata, part: index + 1, parts: pieces.length },
  }));
}

async function main() {
  const startedAt = Date.now();
  const dataset = JSON.parse(await readFile(join(DATA_DIR, 'dota2-wiki.json'), 'utf8'));
  const heroById = new Map(dataset.heroes.map((h) => [h.hero_id, h]));

  console.log('切块中…');
  const candidates = [
    ...buildHeroDocs(dataset.heroes),
    ...buildAbilityDocs(dataset.abilities, heroById),
    ...buildMechanismDocs(dataset.mechanisms),
  ].flatMap(buildChunks);
  console.log(`  候选块 ${candidates.length}`);

  // 用服务端分词器逐块精确计数，超限的当场再切
  const finals = [];
  const overflow = [];
  let cursor = 0;
  const concurrency = 8;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (cursor < candidates.length) {
        const chunk = candidates[cursor++];
        const tokens = await countTokens(chunk.text);
        if (tokens > TOKEN_LIMIT) {
          overflow.push({
            key: `${chunk.doc_type}:${chunk.source_id}:${chunk.metadata.part}`,
            title: chunk.title,
            tokens,
          });
          continue; // 先不入库，下面统一报错，绝不静默丢弃
        }
        finals.push({ ...chunk, token_count: tokens });
      }
    }),
  );

  if (overflow.length) {
    console.error(`\n\x1b[31m有 ${overflow.length} 块超过 ${TOKEN_LIMIT} token 上限\x1b[0m`);
    for (const o of overflow.slice(0, 8)) {
      console.error(`  ${o.key}  ${o.title}  ${o.tokens} token`);
    }
    throw new Error('打包未收敛，拒绝写入不完整的数据');
  }

  // 按 doc_type + source_id + 出现顺序编号，保证 chunk_key 稳定可重入
  const order = { hero: 0, ability: 1, mechanism: 2 };
  // 并发计数会打乱完成顺序，必须显式按 part 排，否则同一实体的块顺序每次都可能不同
  finals.sort(
    (a, b) =>
      order[a.doc_type] - order[b.doc_type] ||
      a.source_id - b.source_id ||
      (a.metadata.part ?? 1) - (b.metadata.part ?? 1),
  );
  const counter = new Map();
  for (const chunk of finals) {
    const seen = counter.get(chunk.doc_type) ?? new Map();
    const index = seen.get(chunk.source_id) ?? 0;
    seen.set(chunk.source_id, index + 1);
    counter.set(chunk.doc_type, seen);
    chunk.chunk_index = index;
    chunk.chunk_key = `${chunk.doc_type}:${chunk.source_id}:${index}`;
  }

  const outPath = join(DATA_DIR, 'chunks.json');
  await writeFile(outPath, `${JSON.stringify(finals, null, 2)}\n`);

  const byType = {};
  for (const chunk of finals) {
    byType[chunk.doc_type] = byType[chunk.doc_type] ?? { n: 0, max: 0, min: Infinity };
    const b = byType[chunk.doc_type];
    b.n++;
    b.max = Math.max(b.max, chunk.token_count);
    b.min = Math.min(b.min, chunk.token_count);
  }

  console.log('\n块数统计');
  for (const [type, b] of Object.entries(byType)) {
    console.log(`  ${type.padEnd(10)} ${String(b.n).padStart(4)} 块   token 范围 ${b.min}–${b.max}`);
  }
  console.log(`  合计       ${String(finals.length).padStart(4)} 块`);
  console.log(`\n耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  console.log(`输出 ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

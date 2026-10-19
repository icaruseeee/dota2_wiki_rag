// 从 data/dota2-wiki.json + data/chunks.json 自动生成答案级评测集。
//
//   npm run gen:eval
//
// 生成规则：每条题都绑定「金标块」（chunk_key），并且必须通过一条硬校验——
// **标准答案能在金标块里逐字找到**。找不到的直接丢弃，不写进评测集。
// 这一步是为了防止造出语料里本来就没有的题。

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR } from './lib/paths.mjs';

const PER_TYPE = { cast: 30, special: 35, ownership: 15, mechanism: 30 };

const norm = (s) =>
  String(s ?? '')
    .replace(/[\s\u00a0]+/g, '')
    .replace(/[，。；：、]/g, '')
    .toLowerCase();

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

const pick = (arr, n) => {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
};

async function main() {
  const dataset = JSON.parse(await readFile(join(DATA_DIR, 'dota2-wiki.json'), 'utf8'));
  const chunks = JSON.parse(await readFile(join(DATA_DIR, 'chunks.json'), 'utf8'));

  const heroById = new Map(dataset.heroes.map((h) => [h.hero_id, h]));

  // chunk_key 索引
  const chunksByEntity = new Map(); // `${doc_type}:${source_id}` -> [chunk]
  for (const c of chunks) {
    const key = `${c.doc_type}:${c.source_id}`;
    if (!chunksByEntity.has(key)) chunksByEntity.set(key, []);
    chunksByEntity.get(key).push(c);
  }
  const chunkText = new Map(chunks.map((c) => [c.chunk_key, c.text]));

  const items = [];
  const dropped = { cast: 0, special: 0, ownership: 0, mechanism: 0 };

  /** 校验答案确实出现在指定块里 */
  const grounded = (answer, keys) => {
    const a = norm(answer);
    if (a.length < 1) return false;
    return keys.some((k) => norm(chunkText.get(k) ?? '').includes(a));
  };

  // 金标用 (doc_type, source_id) + 答案原文，而不是 chunk_key ——
  // 重切后 chunk_key 会重新编号，用 key 做金标会静默失效。
  const add = (type, question, answer, keys, evidence, doc) => {
    if (!grounded(answer, keys)) {
      dropped[type]++;
      return;
    }
    items.push({
      id: `${type}-${String(items.length + 1).padStart(3, '0')}`,
      type,
      question,
      answer: clean(answer),
      gold_doc: doc,
      evidence: clean(evidence),
    });
  };

  // ---- A. 施法数值：魔法消耗 / 冷却 / 施法距离 --------------------------------
  const castPool = [];
  for (const ability of dataset.abilities) {
    const heroes = ability.hero_ids.map((id) => heroById.get(id)?.name_zh).filter(Boolean);
    const keys = (chunksByEntity.get(`ability:${ability.id}`) ?? []).map((c) => c.chunk_key);
    if (!keys.length) continue;
    const fields = [
      ['mana_cost', '需要多少魔法', '魔法消耗'],
      ['cooldown', '冷却时间是多少', '冷却'],
      ['cast_range', '施法距离是多少', '施法距离'],
    ];
    for (const [field, ask, label] of fields) {
      const raw = clean(ability.cast[field]);
      if (!raw || raw === '0' || /^\d+$/.test(raw) === false) continue;
      castPool.push({
        q: `${heroes[0]}的「${ability.name_zh}」${ask}？`,
        a: raw,
        keys,
        evidence: `${label} ${raw}`,
        doc: { doc_type: 'ability', source_id: ability.id },
        ability: ability.name_zh,
      });
    }
  }
  for (const c of pick(castPool, PER_TYPE.cast)) add('cast', c.q, c.a, c.keys, c.evidence, c.doc);

  // ---- B. 技能特殊数值 ---------------------------------------------------------
  const specialPool = [];
  for (const ability of dataset.abilities) {
    const heroes = ability.hero_ids.map((id) => heroById.get(id)?.name_zh).filter(Boolean);
    const keys = (chunksByEntity.get(`ability:${ability.id}`) ?? []).map((c) => c.chunk_key);
    if (!keys.length) continue;
    for (const sv of ability.special_values) {
      if (!sv.show || !sv.value) continue;
      const label = clean(sv.label);
      // 过滤掉纯 key 名、纯色值、过短标签
      if (!/[\u4e00-\u9fa5]/.test(label)) continue;
      if (label.length < 2 || label.length > 18) continue;
      if (/^(是否|标记|类型)$/.test(label)) continue;
      specialPool.push({
        q: `${heroes[0]}的「${ability.name_zh}」的${label}是多少？`,
        a: clean(sv.value),
        keys,
        evidence: `${label}：${sv.value}`,
        doc: { doc_type: 'ability', source_id: ability.id },
        ability: ability.name_zh,
      });
    }
  }
  for (const c of pick(specialPool, PER_TYPE.special))
    add('special', c.q, c.a, c.keys, c.evidence, c.doc);

  // ---- C. 归属关系 -------------------------------------------------------------
  const ownPool = [];
  for (const ability of dataset.abilities) {
    const heroes = ability.hero_ids.map((id) => heroById.get(id)?.name_zh).filter(Boolean);
    if (!heroes.length) continue;
    // 跳过天赋加成这类不是独立技能的条目
    if (/^\+/.test(ability.name_zh) || /^special_bonus_/.test(ability.name_en)) continue;
    const keys = (chunksByEntity.get(`ability:${ability.id}`) ?? []).map((c) => c.chunk_key);
    if (!keys.length) continue;
    ownPool.push({
      q: `「${ability.name_zh}」是哪个英雄的技能？`,
      a: heroes[0],
      keys,
      evidence: `归属英雄：${heroes.join('、')}`,
      doc: { doc_type: 'ability', source_id: ability.id },
    });
  }
  for (const c of pick(ownPool, PER_TYPE.ownership))
    add('ownership', c.q, c.a, c.keys, c.evidence, c.doc);

  // ---- D. 机制概念（从标题 + 首句抽取） ----------------------------------------
  const mechPool = [];
  for (const chunk of chunks) {
    if (chunk.doc_type !== 'mechanism') continue;
    if (!chunk.heading) continue;
    const heading = clean(chunk.heading).replace(/^#+\s*/, '').replace(/\*\*/g, '');
    if (heading.length < 2 || heading.length > 20) continue;
    if (!/[\u4e00-\u9fa5]/.test(heading)) continue;
    // 去掉 MODIFIER_XXX 之类的技术后缀
    const pure = heading.replace(/[A-Z_]{6,}.*$/, '').trim();
    if (pure.length < 2) continue;
    // 只保留名词性标题，避免「不会打断持续施法的技能是什么？」这种病句
    if (/(不会|不能|可以|需要|必须|是否|如何|以下|其中|如果|当|仅|均|都)/.test(pure)) continue;
    if (/[。！？，、；：]/.test(pure)) continue;
    // 泛化标题没有信息量
    if (/^(概述|机制|简述|简介|说明|分类|其他|其它|效果|原理|定义|补充|备注)$/.test(pure)) continue;
    // 「XX的YY」是短语不是概念
    if (pure.includes('的')) continue;

    // 去掉块头（`机制：XXX`）和 markdown 标题行，否则截出的句子在块里不连续
    const body = chunk.text
      .split('\n')
      .filter((line, index) => {
        const t = line.trim();
        if (!t) return false;
        if (/^#{1,6}\s/.test(t)) return false;
        if (index === 0 && /^机制：/.test(t)) return false;
        return true;
      })
      .join('\n')
      .trim();
    const sentence = body
      .split(/(?<=[。！？])/)
      .map((s) => s.trim())
      .find((s) => s.length >= 15 && s.length <= 150 && !s.includes('#'));
    if (!sentence) continue;
    // 过滤掉表格占位与图片残留
    if (/\*（表格|无数据|<img|!\[|^\*|^-\s/.test(sentence)) continue;
    // 未解码的 HTML 与 Valve 占位符
    if (/[<>%]/.test(sentence)) continue;
    // 承接上一段的句子不是定义
    if (/^(以下|但|此时|该效果|该技能|这种|此类|除此之外|其中)/.test(sentence)) continue;
    // 答案必须提到标题的前两个字，否则很可能是同一块里的另一段内容
    if (!sentence.includes(pure.slice(0, 2))) continue;
    mechPool.push({
      q: `「${pure}」指的是什么？`,
      a: sentence,
      keys: [chunk.chunk_key],
      evidence: sentence,
      doc: { doc_type: 'mechanism', source_id: chunk.source_id },
    });
  }
  for (const c of pick(mechPool, PER_TYPE.mechanism))
    add('mechanism', c.q, c.a, c.keys, c.evidence, c.doc);

  // ---- E. 语料外问题（测是否拒答，不参与召回指标） ----------------------------
  const ood = [
    '7.41 版本胜率最高的英雄是谁？',
    '这个版本哪个装备最贵？',
    '昨天 TI 决赛的比分是多少？',
    '国服现在有多少在线玩家？',
    '下个版本会加强哪个英雄？',
  ];
  for (const q of ood) {
    items.push({
      id: `ood-${String(items.length + 1).padStart(3, '0')}`,
      type: 'ood',
      question: q,
      answer: '',
      gold_doc: null,
      evidence: '语料中不存在该信息，正确行为是拒答',
      expect_abstain: true,
    });
  }

  // 去重（同一技能名可能对应多个变体，会生成一模一样的问题）
  const seen = new Set();
  const deduped = items.filter((x) => {
    if (seen.has(x.question)) return false;
    seen.add(x.question);
    return true;
  });

  const outPath = join(DATA_DIR, '..', 'eval', 'qa.jsonl');
  await writeFile(outPath, `${deduped.map((x) => JSON.stringify(x)).join('\n')}\n`);

  const byType = {};
  for (const x of deduped) byType[x.type] = (byType[x.type] ?? 0) + 1;
  console.log('生成完成');
  for (const [t, n] of Object.entries(byType)) console.log(`  ${t.padEnd(12)} ${n} 条`);
  console.log(`  合计         ${deduped.length} 条（去重 ${items.length - deduped.length} 条）`);
  console.log('\n校验未通过而丢弃：');
  for (const [t, n] of Object.entries(dropped)) if (n) console.log(`  ${t.padEnd(12)} ${n} 条`);
  console.log(`\n输出 ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

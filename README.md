# dota2_wiki_rag

刀塔百科（wiki.dota2.com.cn）的本地 RAG：pgvector 向量检索 + Qwen3 重排 + 本地 9B 流式问答。

数据集已经建好（`data/dota2-wiki.json` → `data/chunks.json` → PostgreSQL），
本仓库只负责索引、检索与问答。采集与归一化脚本已移出仓库（见 git 历史 `4010d3f`）。

## 快速开始

```bash
npm install
npm run chunk       # 重新切块 → data/chunks.json（一般不需要跑）
npm run ingest      # 向量化入库，按内容哈希增量
npm run serve       # 对话页面 http://127.0.0.1:8787
```

依赖三个本地服务（launchd 托管，plist 在 `~/Library/LaunchAgents/`）：

| 端口 | 模型 | 用途 | 约束 |
| --- | --- | --- | --- |
| 8080 | Qwen3-Embedding-0.6B-Q8_0 | 向量化，1024 维 | 上下文 2048 token 硬限 |
| 8081 | Qwen3.5-9B-Q4_K_M | 生成 | 8192 上下文，`-np 2` → 每请求 4096 |
| 8082 | Qwen3-Reranker-0.6B-Q6_K | 重排（`/v1/rerank`） | 4096 |
| 5432 | PostgreSQL 18 + pgvector | 存储 | — |

## 对话页面

```bash
npm run serve
# → http://127.0.0.1:8787
```

或者用管理脚本：

```bash
./scripts/service.sh start     # 后台启动，等 /health 通过再返回
./scripts/service.sh status    # 进程 + 健康检查 + 最近日志
./scripts/service.sh logs      # 实时日志
./scripts/service.sh restart
./scripts/service.sh stop
./scripts/service.sh run       # 前台运行，Ctrl+C 退出
./scripts/service.sh check     # 只检查 5432 / 8080 / 8081 / 8082
```

换端口：`PORT=9000 ./scripts/service.sh start`。日志写在 `logs/server.log`。

单进程 HTTP 服务，无前端框架。`POST /api/ask` 返回 SSE 流：
`status`（阶段进度）→ `sources`（检索到的块）→ 若干 `delta`（增量文本）→ `done`。

页面右下角的「精排」开关对应两种模式，实测差异很大：

| 模式 | 来源出现 | 首字 | 典型总耗时 | 检索 Hit@1 |
| --- | --- | --- | --- | --- |
| 快速（默认，纯向量） | **0.5s** | ~10s | 20–40s | 78% |
| 精排（+ Reranker） | 34s | 49s | 78s | **94%** |

精排在这台 M1 上要 20–50 秒（20 个候选、约 13K token），交互场景不划算，所以默认关闭。
生成侧约 10 tok/s，靠流式输出掩盖等待。

## 检索链路

```
data/dota2-wiki.json
    │  npm run chunk     按语义边界切块，用 :8080 的 /tokenize 精确计数
    ▼
data/chunks.json         1718 块
    │  npm run ingest    Qwen3-Embedding（1024 维）→ pgvector
    ▼
PostgreSQL  dota2_wiki.wiki_chunks
    │  向量召回 20 → 重排 → 取 4 块（≤2400 token）
    ▼
Qwen3.5-9B 流式回答 + 来源标注
```

## 切块策略

不按字数硬切，按语义单元切，再用**服务端自己的分词器**逐块校验 token 数：

| 类型 | 策略 | 块数 | token 范围 |
| --- | --- | --- | --- |
| 英雄 | 一英雄一块（超长的按段落再拆） | 129 | 22–1064 |
| 技能 | 一技能一块（超长的按段落再拆） | 1040 | 21–1674 |
| 机制文 | 按 h2/h3 切语义小节 → 合并 <150 字符的残片 → 贪心合并到 ~1000 token | 549 | 59–1633 |
| 合计 | | **1718** | 上限 1674 |

目标 1000 token、硬上限 1800（给 2048 留 248 余量）。
**超限的块会让 `chunk` 直接报错退出，不会静默丢弃**——因为 embedding 服务对超限输入返回的是
HTTP 400 而非截断，静默跳过会让内容从索引里凭空消失且无人察觉。

按 h2-h4 切分会切出大量「标题 + 一句话」的引导小节，这类碎片用词密集、余弦相似度天然偏高，
会把真正有内容的块挤出前面，所以打包前先把不足 150 字符的片段并入下一节。

### 跳转桩

157 篇机制文里有 **17 篇是跳转桩**——正文只剩一句「请查询[X]页面」，本身没有内容：

| 跳转桩 | 指向 |
| --- | --- |
| 弱驱散、强驱散、死亡驱散、减益免疫驱散 | 驱散 |
| 必中、克敌机先、致盲、落空、闪避 | 命中 |
| 模型体积、选择体积、边界体积、碰撞体积 | 单位体积 |
| 强制移动、蛊惑 | 恐惧 |
| 真实视域 | 隐身 |
| 伤害传递 | 攻击分裂 / 攻击溅射 / 伤害结算流程 |

它们不该被索引：正文只有 6 个字符，却因为原样命中查询词而排在真内容前面。
数据里已把它们记进 `mechanisms[].redirect_to`，切块时跳过，并把名字作为别名写进目标页的块头
（`机制：驱散（站内跳转页：弱驱散、强驱散…）`），查「弱驱散」会直接落到「驱散」的正文上。

### 增量入库

每个块带 `content_hash`（文本的 md5）。入库只重算「key 存在但哈希不一致」的块，
并清理重切后不再存在的旧 key。改一次切块策略通常只需重算几百块，而不是全部 1718 块。

## 表结构

`src/schema.sql` 建表 `wiki_chunks`，关键字段：`chunk_key`（`doc_type:source_id:part`，重跑幂等）、
`doc_type`、`text`、`token_count`、`content_hash`、`metadata jsonb`、`embedding vector(1024)`。

索引：HNSW（余弦）、`(doc_type, source_id)`、metadata GIN。共约 18 MB。

trigram 词面索引曾经建过（15 MB），但实测 `idx_scan = 0`、且当前语料下向量召回已达 100%，
已移除。将来做 RRF 混合检索时重建即可（`CREATE EXTENSION pg_trgm` + GIN 索引，秒级）。

## 评测

| 评测 | 规模 | 指标 |
| --- | --- | --- |
| `npm run eval` | 18 个手写问题 | 纯向量 Hit@1 83% / Hit@5 94%；+重排 Hit@1 **94%** / Hit@5 **100%** / MRR 0.972 |
| `npm run eval:answer` | 115 条自动生成（110 条可判分 + 5 条拒答） | 召回@N、MRR、答案正确、引用命中、拒答正确、数字幻觉 |

评测集由 `npm run gen:eval` 从数据集生成，金标是「文档 + 答案原文」而不是 chunk_key（重切不会失效），并强制校验
「标准答案能在金标块里逐字找到」——不通过就丢弃，避免造出语料里没有的题。

## 数据集

| 类型 | 数量 |
| --- | --- |
| 英雄 | 128（127 个可用英雄 + 傀儡目标） |
| 技能 | 852 |
| 机制文章 | 157 |
| 机制标签 | 973 |
| 内嵌表单 | 288 |
| 分类节点 / 首页栏目 | 139 / 9 |

正文合计约 90 万字符。`data/dota2-wiki.json` 为扁平数组 + 外键：

```
heroes.ability_ids  ──► abilities.id
abilities.hero_ids  ──► heroes.hero_id
abilities.tags / details / mechanics[].tag / effects[].tags ──► tags.id
mechanisms.form_ids ──► forms.id
```

每篇文档都带 `url`，可直接用作引用来源。

## 已知数据缺陷（上游问题）

- `傀儡目标`（hero_id=127）没有技能，也没有传记。
- 3 个技能的 `name_zh` 被上游截断到 20 字符：`special_bonus_unique_visage_7`、
  `special_bonus_unique_visage_1`、`special_bonus_unique_faceless_void_4`。
- 标签 id `454`、`644`、`1225` 被引用但不在 973 条表内，输出中保留为 `{"id": 454, "name": null}`。
- 护甲公式在原文里是一张 PNG，文本侧没有可提取内容（问答时只能给定性结论）。
- 冰川护体是水晶室女的魔晶技能，但 wiki 未标注、`shard_description` 为空、
  Valve datafeed 的 `ability_has_shard` 也是 false。
- 全库 148 张图片的内容未入库。

## 目录结构

```
src/
  server.mjs        HTTP + SSE
  lib/rag.mjs       检索与流式生成
  lib/paths.mjs     路径常量
  chunk.mjs         切块
  ingest.mjs        向量化入库
  search.mjs        检索 CLI
  ask.mjs           端到端问答 CLI
  eval.mjs          检索评测
  eval-answer.mjs   答案级评测
  gen-eval.mjs      评测集生成
  schema.sql        表结构
public/index.html   对话页面
scripts/service.sh  服务管理
eval/               评测集与结果
```

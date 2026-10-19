# Dota 2 Wiki RAG

[English](README.md) | 简体中文

一个面向刀塔百科（`wiki.dota2.com.cn`）的本地 RAG 参考实现：实体感知切块、
Qwen3 Embedding、PostgreSQL + pgvector、可选的 Qwen3 交叉编码器重排，以及本地
Qwen3.5-9B 的流式回答。

这个仓库的目标不是包装成“生产级问答平台”，而是把 RAG 的工程取舍摊开：索引了什么、
如何评测、哪些能力故意没做，以及当前链路在哪里还会失败。

## 关键数据

| 项目 | 数值 |
| --- | --- |
| 可索引文档实体 | 1,120 个 |
| 原始实体 | 128 个英雄、852 个技能、157 篇机制文 |
| 检索块 | 1,718 块 |
| 运行时 token 过滤后可检索 | 1,652 块（`token_count >= 60`） |
| 结构化元数据 | 973 个标签、288 个内嵌表单、139 个分类 |
| Embedding | Qwen3-Embedding-0.6B，1,024 维，2,048 token 上下文 |
| 向量存储 | PostgreSQL + pgvector，HNSW 余弦索引 |
| 重排器 | Qwen3-Reranker-0.6B，可选 |
| 生成模型 | Qwen3.5-9B，本地 llama.cpp，SSE 流式输出 |
| 检索评测 | 18 道手写问题 |
| 答案评测 | 115 条：110 条可判分问题 + 5 条语料外问题 |

目标机器 Apple M1 / 16 GB 上的记录结果：

| 模式 | 检索质量 |
| --- | --- |
| 纯向量 | Hit@1 83%，Hit@5 94% |
| 向量 + 重排 | Hit@1 94%，Hit@5 100%，MRR 0.972 |

重排在这台机器上处理 20 个候选要 20–50 秒，因此网页默认使用快速向量检索，
精排放在显式开关后面。

## 这个项目值得看的点

- **按实体和语义切块，不按固定字数硬切。** 英雄和技能通常一个实体一块；长机制文
  按 Markdown 标题切分，再向目标 token 数打包。
- **用服务端分词器精确计数。** 超长块会让流程直接报错，不会被静默截断或丢弃，
  避免内容从索引里“凭空消失”。
- **处理站内跳转桩。** 17 篇机制文正文只有“请查询另一页”。它们不进入索引，
  名字会作为别名写进目标页的块头。
- **幂等增量入库。** 稳定的 `chunk_key` 加内容哈希，内容没变的块不重复算向量。
- **质量和延迟是显式产品选择。** 同一条检索链路可以只走向量，也可以加交叉编码器精排。
- **两层评测。** 检索层看 Hit@k 和 MRR；答案层看上下文召回、答案正确性、引用、
  拒答和数字是否被资料支持。

## 架构

```text
离线索引
========
data/dota2-wiki.json
        │
        │  npm run chunk
        │  - 实体级文档组装
        │  - 标题感知切分
        │  - /tokenize 精确计数
        ▼
data/chunks.json  （1,718 块）
        │
        │  npm run ingest
        │  - md5(content) 增量判断
        │  - Qwen3-Embedding，1,024 维
        │  - 按稳定 chunk_key upsert
        ▼
PostgreSQL: wiki_chunks + pgvector HNSW（余弦）

在线问答
========
问题
  │
  ├─ query embedding
  ├─ 向量召回 top 20
  ├─ 可选：对 20 个候选做 cross-encoder 精排
  ├─ 在 2,400 token 预算内选最多 4 块
  ├─ 拼装“只依据资料回答”的 prompt
  └─ SSE 流式输出答案 + 来源卡片
```

## 环境要求

- Node.js 20 或更高版本。
- PostgreSQL 18 + pgvector 0.8.7。
- llama.cpp，以及三个本地模型服务：

| 端口 | 模型 | 作用 | 上下文 |
| --- | --- | --- | --- |
| 8080 | Qwen3-Embedding-0.6B-Q8_0 | 向量化与分词 | 2,048 token |
| 8081 | Qwen3.5-9B-Q4_K_M | 答案生成 | 8,192 token（`-np 2`） |
| 8082 | Qwen3-Reranker-0.6B-Q6_K | 交叉编码器重排 | 4,096 token |

数据导出和模型文件都不在仓库里。`data/` 被 git 忽略；评测脚本默认本地已有
`data/dota2-wiki.json`。抓取和上游归一化脚本也不在当前仓库中。

模型转换、launchd 配置和 llama.cpp 踩坑见
[docs/llama-cpp-stack.md](docs/llama-cpp-stack.md)。

## 快速开始

```bash
npm install

# 先启动 PostgreSQL 和三个 llama.cpp 服务，再检查四个端口。
./scripts/service.sh check

# 只有源数据或切块逻辑变化时才需要重建。
# 这里依赖 embedding 服务的 /tokenize 做精确计数。
npm run chunk

# 向量化并写入 PostgreSQL；可以重复执行。
npm run ingest

# 启动网页：http://127.0.0.1:8787
npm run serve
```

常用服务命令：

```bash
./scripts/service.sh start
./scripts/service.sh status
./scripts/service.sh logs
./scripts/service.sh restart
./scripts/service.sh stop
PORT=9000 ./scripts/service.sh start
```

命令行示例：

```bash
node src/search.mjs "哪些技能不能被驱散"
node src/ask.mjs "弱驱散和强驱散有什么区别？"
RERANK=1 node src/ask.mjs "弱驱散和强驱散有什么区别？"
```

## 配置

| 环境变量 | 默认值 | 作用 |
| --- | --- | --- |
| `DATABASE_URL` | `postgresql://messiah@127.0.0.1:5432/dota2_wiki` | PostgreSQL 连接串 |
| `DOTA2_EMBED_URL` | `http://127.0.0.1:8080` | 向量化与分词服务 |
| `DOTA2_CHAT_URL` | `http://127.0.0.1:8081` | 生成服务 |
| `DOTA2_RERANK_URL` | `http://127.0.0.1:8082` | 重排服务 |
| `RECALL_K` | `20` | 每道题的向量候选数 |
| `TOP_N` | `4` | 最多放入 prompt 的块数 |
| `CONTEXT_BUDGET` | `2400` | 检索上下文的 token 预算 |
| `MIN_TOKENS` | `60` | 检索时忽略过短的块 |
| `PORT` | `8787` | Web 服务端口 |
| `HOST` | `127.0.0.1` | Web 服务监听地址 |
| `DOTA2_INGEST_CONCURRENCY` | `6` | 入库时并发 embedding 请求数 |
| `RERANK` | 未设置 | 仅 CLI 使用；`RERANK=1` 开启精排 |

网页请求用 `"rerank": true` 开启精排，CLI 用 `RERANK=1`。

## HTTP API

### `POST /api/ask`

```bash
curl -N http://127.0.0.1:8787/api/ask \
  -H 'Content-Type: application/json' \
  -d '{"question":"弱驱散和强驱散有什么区别？","rerank":false}'
```

返回 `text/event-stream`，事件如下：

| 事件 | 内容 |
| --- | --- |
| `status` | 当前阶段 |
| `sources` | 选中的块、检索耗时、上下文 token 数 |
| `delta` | 增量答案文本 |
| `done` | 端到端耗时和模型 usage |
| `error` | 错误或取消信息 |

问题长度上限 500 字。服务默认只监听回环地址，没有鉴权和限流。

### `GET /health`

返回进程配置。它只表示 Web 进程存活，不检查 PostgreSQL 或任何模型服务。

## 数据处理

### 切块策略

| 文档类型 | 策略 | 块数 | token 范围 |
| --- | --- | --- | --- |
| 英雄 | 一英雄一块，超长才拆 | 129 | 22–1,064 |
| 技能 | 一技能一块，超长才拆 | 1,040 | 21–1,674 |
| 机制文 | 按 h2–h4 切分、合并碎片、贪心打包 | 549 | 59–1,633 |
| **合计** | | **1,718** | **21–1,674** |

机制文打包目标约 1,000 token，软上限 1,800，embedding 服务硬上限 2,048。
最终每个块都用 `/tokenize` 精确复核；超限会直接报错，不做静默截断。

两个容易忽略的细节：

- 不足 150 字符的小节先向后合并。只有标题和一句话的碎片词面密度高，余弦相似度
  容易虚高，会把真正有内容的块挤出前面。
- 每个块前会拼一个块头，把实体名、所属英雄或站内别名带进向量。这样检索到一个小节时，
  它仍然知道自己属于哪篇文档。

运行时的 `MIN_TOKENS=60` 过滤会排除 66 个过短块；它们仍然留在数据库中，
方便审计和未来重新切块。

### 增量入库

每个块包含：

- `chunk_key = doc_type:source_id:chunk_index`，普通重跑保持稳定。
- `content_hash = md5(text)`，内容没变就跳过向量化。
- `metadata`，保存来源 ID、标签、别名、分片序号等。

`npm run ingest` 只重算内容发生变化的块，同时清理 `chunks.json` 里已不存在的旧 key，
并校验每个向量都是 1,024 维。`-- --force` 强制全量重算，`-- --reset` 先清空表。

## 存储

主表是 `wiki_chunks`，关键字段：

| 字段 | 作用 |
| --- | --- |
| `chunk_key` | 主键和幂等键 |
| `doc_type`, `source_id`, `chunk_index` | 实体与顺序元数据 |
| `title`, `heading`, `url` | 引用与页面展示 |
| `text`, `token_count` | prompt 素材与预算计算 |
| `content_hash` | 增量入库 |
| `metadata` | 标签、别名、分片等过滤信息 |
| `embedding vector(1024)` | 稠密检索向量 |

索引：

- HNSW + `vector_cosine_ops`，用于近似最近邻检索。
- `(doc_type, source_id)` 复合索引，用于按实体查块。
- `metadata` 的 GIN 索引，为将来的结构化过滤预留。

只有 1,718 行时，PostgreSQL 仍可能选择顺序扫描；HNSW 是为规模增长准备的，
不代表当前一定要靠近似索引才能跑。trigram 索引曾经建过，但因为从未被查询使用，
且没有接入混合检索，已经移除。

## 评测

### 检索评测

```bash
npm run eval
npm run eval -- -v
```

`eval/questions.json` 有 18 道手写问题。命中判定是期望的 `(doc_type, title)`
出现在返回结果里。

| 链路 | Hit@1 | Hit@5 | MRR |
| --- | --- | --- | --- |
| 纯向量 | 83% | 94% | 此处未记录 |
| 向量 + 重排 | 94% | 100% | 0.972 |

### 答案评测

```bash
npm run eval:answer
npm run eval:answer -- --limit 20
npm run eval:answer -- --types cast,ood
```

115 条数据包含 30 条施法数值、35 条技能特殊数值、15 条归属关系、30 条机制概念，
以及 5 条语料外问题。脚本输出：

- 金标文档是否进入上下文；
- 金标文档在重排列表中的 MRR；
- 归一化后的答案是否正确；
- 引用是否命中金标块；
- 语料外问题是否正确拒答；
- 回答中的数字是否都能在上下文中找到。

评测集由数据自动生成，并要求标准答案能在金标块中逐字找到。这能避免生成语料里
根本不存在的题，但不等同于人工标注基准。

这些数字来自作者本机 M1，是工程基线，不是通用的 Dota 问答 benchmark。

## 关键设计取舍

| 决策 | 原因 |
| --- | --- |
| 本地模型 + 本地 PostgreSQL | 无外部 API 依赖，延迟和成本可观测 |
| 直接消费结构化导出 | 上游已处理导航、占位符和表单，仓库不重复造解析器 |
| 实体感知切块 | Dota 问答通常围绕一个英雄、技能或机制，固定窗口会切断语义单位 |
| 先做稠密检索 | 语料小、领域集中，当前向量召回已经足够强 |
| 精排可选 | 质量更好，但在这台机器上不适合默认开启 |
| token 超限直接失败 | 静默截断会让内容从索引消失且难以发现 |
| PostgreSQL + pgvector | 元数据、文本和向量共用一个依赖，适合单语料小规模场景 |

## 已知限制

- 只有稠密检索，没有 BM25/trigram 稀疏分支，也没有 RRF 融合。
- 没有查询改写、HyDE、多查询、MMR、每文档上限或相邻块扩展。
- 没有分数阈值或自适应 top-k；固定的 4 块/2,400 token 预算仍可能混入噪音。
- embedding 模型推荐的 query 侧 Instruct 前缀没有在当前运行代码中实现，
  这是一个应该做 A/B 的优化项。
- 图片和流程图没有入库，至少有一个护甲公式只存在于图片里。
- 精排较慢，只在显式开启时运行。
- 模型会生成引用编号，但目前没有逐句验证引用是否真的支持该结论。
- `eval:answer` 用子串匹配和启发式规则，不是 LLM judge 或 entailment 模型。
- 入库不是原子操作，全量重建也不是零停机。
- 没有查询缓存、鉴权、限流或 CI。
- `/health` 不检查数据库和模型依赖。

### 上游数据缺陷

这些是源数据问题，不是检索 bug：

- `傀儡目标`（hero_id=127）没有技能，也没有传记。
- 3 个技能的中文名被上游截断到 20 字符：`special_bonus_unique_visage_7`、
  `special_bonus_unique_visage_1`、`special_bonus_unique_faceless_void_4`。
- 标签 ID 454、644、1225 被引用，但不在 973 条标签表内。
- 护甲公式在源页面里是一张 PNG，文本索引只能支持定性回答。
- 水晶室女的「冰川护体」魔晶关系在 wiki 和 Valve datafeed 中标注不一致。
- 图片内容没有入库；项目记录中有 148 张内容图片。

完整的面试讲解、未采用 RAG 能力及原因见
[docs/RAG_INTERVIEW_GUIDE.md](docs/RAG_INTERVIEW_GUIDE.md)。

## 目录结构

```text
src/
  server.mjs         HTTP 服务和 SSE
  lib/rag.mjs        检索、prompt、流式生成
  lib/paths.mjs      路径常量
  chunk.mjs          源数据转检索块
  ingest.mjs         向量化与入库
  search.mjs         只做检索的 CLI
  ask.mjs            端到端 CLI
  eval.mjs           检索评测
  eval-answer.mjs    答案级评测
  gen-eval.mjs       生成有金标约束的评测集
  schema.sql         表与索引
public/index.html    极简对话页
scripts/service.sh   服务管理与依赖检查
eval/                评测集和结果
docs/                部署记录与 RAG 面试文档
```

## 文档

- [English README](README.md)
- [RAG 面试准备与取舍说明](docs/RAG_INTERVIEW_GUIDE.md)
- [本地 llama.cpp 推理栈](docs/llama-cpp-stack.md)
- [路线图与 TODO](docs/TODO.md)

## 数据来源

源站是 `https://wiki.dota2.com.cn`。当前导出标注游戏版本为 `7.41f`，来自站点结构化
接口。Dota 2 及相关素材归 Valve 所有；本仓库是技术实验，不是官方 wiki 或游戏服务。

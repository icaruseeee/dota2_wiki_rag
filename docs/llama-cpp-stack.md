# 本地推理栈：llama.cpp 部署与踩坑记录

> 本文所有结论均由 2026-10-16 在目标机器上实测得到，含三次真实链路调用与一次缓存失效复现。
> 目标：用 llama.cpp 替代 Ollama，为 dota2_wiki_rag 提供「向量召回 + 精排 + 生成」三个本地服务。

## 1. 为什么不用 Ollama

| 维度 | Ollama | llama.cpp |
| --- | --- | --- |
| 安装体积 | 114 MB（含 Electron 界面） | 19.5 MB |
| 常驻进程 | `ollama serve` 守护进程常驻 | 无。不启动服务就没有进程 |
| 模型驻留 | 默认最后一次调用后 keep-alive 5 分钟 | 进程退出即完全释放 |
| 模型管理 | 自动 `pull` / tag 管理 | 自己管 GGUF 文件 |
| 底层 | 就是套在 llama.cpp 外面的壳 | 本体 |

「省资源」的关键不在引擎，而在**进程生命周期**：Ollama 的守护进程 + keep-alive 是省不掉的常量开销，llama.cpp 按需启动、随时归零。

顺带澄清一个命名：**不存在「ollama cpp」这个项目**。Ollama 底层用的就是 llama.cpp（ggml 推理后端），所以「换 llama.cpp」是绕过外壳直用内核，不是换了一个引擎。

## 2. 环境与安装

实测机器：Apple M1 / 16 GB 统一内存 / 8 核 / macOS 26.5.1 / Homebrew 7.0.6。

```bash
brew install llama.cpp
```

装出来的版本是 `0.6.0 (build 11429, commit d81235049)`，落在 `/opt/homebrew/Cellar/llama.cpp/0.6.0_1`，二进制软链到 `/opt/homebrew/bin`（`llama-server`、`llama-cli`、`llama-bench`、`llama-quantize` 等 35 个）。

依赖与副作用：

- 新装 `libomp 23.1.3`、`ggml 0.27.0`
- `ca-certificates` 从 2026-08-13 升到 2026-09-25
- **默认 openssl 从 openssl@3 切到 openssl@4**，解掉了 6570 个软链。有别的工具链硬绑 openssl@3 的话要留意。

后端能力（`llama-cli --list-devices` 实测）：

```
BLAS: Accelerate (0 MiB, 0 MiB free)
MTL0: Apple M1 (12124 MiB, 12123 MiB free)
```

即 Metal GPU 加速可用，可用显存约 11.8 GB（统一内存），另有 Accelerate BLAS。

## 3. 模型选型

RAG 需要三种角色。先记一个结论：**向量化和检索不是两个模型，是同一个模型的两次调用**。只有 query 和文档落在同一向量空间，余弦相似度才有意义；换 embedding 模型必须整库重算。

| 角色 | 模型 | 量化 | 文件 | 为什么 |
| --- | --- | --- | --- | --- |
| 向量化 / 召回 | Qwen3-Embedding-0.6B | Q8_0 | 610 MB | 官方唯一的 sub-1B 文本 embedding |
| 精排 | Qwen3-Reranker-0.6B | Q6_K | 472 MB | cross-encoder，只对 top-k 逐对打分 |
| 生成 | Qwen3.5-9B | Q4_K_M | 5417 MB | 当前世代，16 GB 机器能舒服跑的最大档 |

### 选型时踩的概念坑

**Qwen 最新世代（3.5 / 3.6 / 3.8）没有 embedding 模型。** 按 Hugging Face 的 pipeline 标签翻官方仓库，Qwen 全系官方 embedding 只有五个：

```
Qwen3-Embedding-0.6B / 4B / 8B      2025-06
Qwen3-VL-Embedding-2B / 8B          2026-01（多模态）
```

3.5 / 3.6 / 3.8 三代一个 embedding 都没出。而且 **0.6B 这个尺寸只存在于 Qwen3 代**：3.8 最小是 27B，3.5 最小是 `Qwen3.5-0.8B`——一个 `image-text-to-text` 的多模态**生成**模型，官方模型卡写明用途是「原型验证、任务微调」，做不了 embedding。

所以「最新世代 + 0.6B + embedding」这个组合不存在。`Qwen3-Embedding-0.6B` 不是过时，而是 Qwen 没在这个尺寸上继续迭代。

### 文件校验

三个文件均经字节数 + SHA256 校验（[~/models](/Users/messiah/models)）：

| 文件 | 字节数 | SHA256 |
| --- | --- | --- |
| `Qwen3-Embedding-0.6B-Q8_0.gguf` | 639150592 | `06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439` |
| `Qwen3-Reranker-0.6B-Q6_K.gguf` | 494879136 | `5916ab2926388177a0a7b6eedfd909d214a29592ce35153a7d9ff86c08e4b99e` |
| `Qwen3.5-9B-Q4_K_M.gguf` | 5680522464 | `03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8` |

## 4. 部署

不装 `brew services`，也不用 `nohup`。三个服务注册成 launchd 用户代理，**`RunAtLoad` 设为 `false`**——需要时才起，开机不自动跑，保住「不留常驻进程」这个初衷。

plist 位于 `~/Library/LaunchAgents/`：

| Label | 端口 | 模型 |
| --- | --- | --- |
| `com.local.llama.embed` | 8080 | Qwen3-Embedding-0.6B-Q8_0 |
| `com.local.llama.chat` | 8081 | Qwen3.5-9B-Q4_K_M |
| `com.local.llama.rerank` | 8082 | Qwen3-Reranker-0.6B-Q6_K |

日志：`~/Library/Logs/llama/{embed,chat,rerank}.log`（stderr 同名 `.err.log`）。

### 日常操作

```bash
uid=$(id -u)

# 启动 / 停止（首次需先 bootstrap 一次）
launchctl bootstrap gui/$uid ~/Library/LaunchAgents/com.local.llama.embed.plist
launchctl kickstart gui/$uid/com.local.llama.embed
launchctl kill SIGTERM gui/$uid/com.local.llama.embed

# 查状态（第一列是 PID，第二列是上次退出码）
launchctl list | grep com.local.llama
```

不想用 launchd 也可以直接前台跑，Ctrl+C 即彻底释放内存：

```bash
llama-server -m ~/models/Qwen3-Embedding-0.6B-Q8_0.gguf --embeddings --pooling last -c 2048 -b 2048 -ub 2048 --port 8080
llama-server -m ~/models/Qwen3-Reranker-0.6B-Q6_K.gguf --reranking --pooling rank --embedding -c 4096 -b 4096 -ub 4096 --port 8082
llama-server -m ~/models/Qwen3.5-9B-Q4_K_M.gguf -c 8192 -np 2 --port 8081
```

## 5. 使用

三个服务都是 OpenAI 兼容接口，base_url 直接指过去即可。

### 向量化（8080）

**query 和文档的前缀不对称**，这是模型侧最容易踩的坑。下面记录的是
Qwen3-Embedding 的推荐用法，**当前仓库的运行代码还没有拼接 query 前缀**，
不能把这段示例当成已落地实现：

```python
# query：必须加 Instruct 前缀
query = f"Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:{q}"
# 文档：不加任何前缀
resp = post("http://127.0.0.1:8080/v1/embeddings", {"input": [query] + docs})
```

### 精排（8082）

```python
resp = post("http://127.0.0.1:8082/v1/rerank",
            {"query": q, "documents": [d["text"] for d in candidates]})
```

### 生成（8081）

```python
post("http://127.0.0.1:8081/v1/chat/completions", {
    "messages": [{"role": "system", "content": "只依据 Context 回答，简洁。"},
                 {"role": "user", "content": f"Context:\n{ctx}\n\nQuestion: {q}"}],
    "max_tokens": 200, "temperature": 0.2,
    "chat_template_kwargs": {"enable_thinking": False},   # 关键：关掉思考
})
```

### 实测链路

6 条语料的迷你语料库，问「Blink Dagger 多少钱？冷却多久？」：

```
① 向量召回 top1  0.8115   Blink Dagger 售价 2250 金币…
② 精排后 top1    0.999985 Blink Dagger 售价 2250 金币…（第二名骤降到 0.256082）
③ 生成          售价 2250 金币，冷却 12 秒。      链路合计 3.9s
```

精排把 0.81 / 0.68 的模糊差距锐化成 0.999985 / 0.256082，这正是两阶段检索的价值。

## 6. 关键坑

### 6.1 reranker 的 GGUF 不能随便下（最坑的一个）

**症状**：精排接口能起、能返回，但分数是垃圾。实测正确文档得 `7.7e-10`，无关文档反而得 `0.8455`，排序完全反了。

**根因**：社区大多数 Qwen3-Reranker GGUF 缺 reranker 专用张量（llama.cpp issue #16407）。官方的 `convert_hf_to_gguf.py` 会额外做四件事，naive 转换器全跳过：

1. 从 `lm_head` 抽出 `cls.output.weight` 当分类头
2. 设 `pooling_type = RANK`
3. 写入 `classifier.output_labels = ["yes", "no"]`
4. 内置 rerank chat template

缺了这些，服务端没有任何东西可以拿来算分数。

**解决**：用官方脚本转换的版本（实测 `Voodisss/Qwen3-Reranker-0.6B-GGUF-llama_cpp` 可用）。启动参数必须是：

```bash
llama-server -m Qwen3-Reranker-0.6B-Q6_K.gguf --reranking --pooling rank --embedding ...
```

**两个附加注意点**：

- 走 `/v1/rerank`，**不要**走 `/v1/embeddings`——对 reranker 模型后者返回全 0。
- 官方参考实现的 suffix 里带一个空 think 块（`<think>\n\n</think>\n\n`）。好在正确转换的 GGUF 会把模板一并内建，不用自己在请求里拼。

正确配置下的实测：正确文档 `0.999535`，两条无关文档 `0.000186 / 0.000104`。

### 6.2 Qwen3.5 默认思考模式会吃光 token

**症状**：请求返回 200，`content` 却是空字符串，而 `usage.completion_tokens` 显示确实生成了 token。

**根因**：Qwen3.5 系列默认开思考，输出进 `message.reasoning_content`（响应里多一个字段），正文要等思考结束才开始。给 150 甚至 400 `max_tokens` 都会被思考过程吃光。

**还有个坑套坑**：Qwen3 常用的 `/no_think` 提示词开关对 Qwen3.5 **无效**，实测仍然照常思考。

**解决**（二选一）：

```python
# 单次请求控制
{"chat_template_kwargs": {"enable_thinking": False}}

# 或服务端全局控制
llama-server ... --reasoning-budget 0     # 0 = 立刻结束思考，-1 = 不限制
```

模板里的判定条件是 `{%- if enable_thinking is defined and enable_thinking is true %}`，为 false 时会塞入空 think 块，正文直接开始。

RAG 场景建议默认关掉：开思考时同一个问题从 3 秒变成 40 秒，且答案质量没有提升。需要多跳推理时再单独打开。

### 6.3 embedding 的前缀不对称

按模型卡和官方示例，query 端应带
`Instruct: {任务描述}\nQuery:{问题}`，文档端**不加前缀**。两边都加或都不加都可能掉点。
另外 pooling 必须是 `last`（last-token pooling），不是 `mean`。

> 仓库现状：`src/lib/rag.mjs` 的 `embed(question)` 直接把原问题送入
> `/v1/embeddings`，没有拼接 Instruct 前缀。这是一个待做 A/B 的优化项，
> 不是当前已实现能力；修改后需要用 `npm run eval` 和 `npm run eval:answer`
> 对照质量与延迟。

### 6.4 M1 的吞吐天花板在内存带宽，不在配置

实测生成 9.8 tok/s。M1 内存带宽 68 GB/s，9B Q4_K_M 模型 5.7 GB，理论极限约 12 tok/s——已经跑到八成，调参榨不出更多。

想更快只能换小模型：`Qwen3.5-4B`（2.6 GB）吞吐大约翻倍。批量跑评测时值得换。

### 6.5 下载与缓存

- `llama-server -hf <repo>:<quant>` 会自动下载并缓存，缓存位置用 `LLAMA_CACHE` 环境变量固定最清楚（例如 `LLAMA_CACHE=~/models`）。用 `llama-cli --cache-list` 查缓存内容。
- 大文件下载中断后**不要重头下**，`curl -C -` 从断点续传。本次 5.4 GB 的生成模型续传过一次。
- 下完务必对字节数，Hugging Face 的 CDN 支持 `curl -sIL` 读 `content-length`。

### 6.6 卸载 Ollama 的一个尾巴

Ollama 官方 App 会在 `/usr/local/bin/ollama` 建一个软链，属主是 `root:wheel`，删它需要 sudo：

```bash
sudo rm /usr/local/bin/ollama
```

不删也没事——重装 App 时会自动把同一路径重建为有效软链。

### 6.7 别把向量化服务当通用服务用

`--embeddings` 会把服务限制为纯 embedding 用途；反过来，reranker 模型挂了 `--reranking` 后虽然 chat 端点仍可访问，但输出无意义。三个角色各自一个进程、各自一个端口，不要混用。

## 7. 性能与资源实测

| 指标 | 实测值 |
| --- | --- |
| 向量维度 | 1024 |
| 向量化区分度 | 正确 0.8115 / 无关 0.3996 |
| 精排区分度 | 正确 0.999985 / 无关 0.256082 |
| 生成长度吞吐 | 9.8 tok/s |
| 生成 prompt 处理 | 50.7 tok/s |
| 端到端链路（6 条语料） | 3.9 s |
| 三服务同时常驻内存 | 约 7 GB |
| 磁盘占用 | 约 10 GB（模型 6.5 GB + 依赖） |

对比：同机器上 Ollama 的 `deepseek-r1:14b`（Q4 约 9 GB）在 16 GB 统一内存里会让系统和浏览器明显变卡；现在的组合把生成端压到 5.4 GB，且**不用时进程不存在，占用归零**。

## 8. 排错清单

| 症状 | 先查这里 |
| --- | --- |
| 精排分数接近 0 或排序颠倒 | GGUF 是否官方脚本转换（缺分类头），启动参数是否 `--reranking --pooling rank` |
| `content` 为空但消耗了 token | 思考模式没关，看 `reasoning_content` 字段长不长 |
| 向量检索结果莫名 | query 是否带了 `Instruct:` 前缀、文档是否误加、`--pooling` 是否 `last` |
| 端口连不上 | `launchctl list \| grep com.local.llama`，再看 `~/Library/Logs/llama/*.err.log` |
| 生成很慢 | 正常。先看是不是开着思考模式，再考虑换 4B |
| 服务莫名退出 | plist 里 `RunAtLoad=false`，`launchctl kickstart` 才会起；`KeepAlive=false` 不会自动拉起 |
| 内存吃紧 | 三个服务不必同时开：建索引只需 8080，批量生成只需 8081 |

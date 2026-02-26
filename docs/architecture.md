# 架构与请求流程

> 面向刚上手此仓库的开发者，完整梳理项目原理、目录结构、启动流程、请求生命周期和关键设计决策。

---

## 目录

1. [项目定位](#项目定位)
2. [技术栈速览](#技术栈速览)
3. [目录结构](#目录结构)
4. [启动流程](#启动流程)
5. [全局状态 (State)](#全局状态-state)
6. [请求生命周期（通用）](#请求生命周期通用)
7. [路由详解](#路由详解)
   - [Chat Completions](#chat-completions-路由)
   - [Responses API](#responses-api-路由)
   - [Anthropic Messages API (智能路由)](#anthropic-messages-api-路由智能路由)
   - [Models / Embeddings / Usage / Token](#其他路由)
8. [计费优化机制](#计费优化机制)
9. [认证体系](#认证体系)
10. [文件与路径管理](#文件与路径管理)

---

## 项目定位

`copilot-api` 将 GitHub Copilot 订阅背后的 LLM 能力暴露为标准的 **OpenAI / Anthropic API** 端点。典型用户是 **Claude Code**、**OpenCode** 等 AI 编程助手 —— 它们只需将 base URL 指向本服务即可复用 Copilot 提供的模型。

核心工作：

```
客户端（Claude Code / OpenCode / curl …）
  │  OpenAI 或 Anthropic 协议
  ▼
copilot-api（Hono 服务器）
  │  1. 认证 & 限速
  │  2. 协议翻译（Anthropic → OpenAI / Responses）
  │  3. 计费优化（subagent 标记、compact/warmup 检测、tool_result 合并）
  ▼
GitHub Copilot 后端 API
  │  Chat Completions / Responses / Messages
  ▼
LLM（GPT-4o、Claude Sonnet 4、Codex …）
```

---

## 技术栈速览

| 层 | 选型 | 说明 |
|----|------|------|
| 运行时 | Node.js ≥ 24 | 原生 `fetch`、`crypto`，无需 polyfill |
| HTTP 框架 | [Hono](https://hono.dev) | 轻量、类型友好、中间件链 |
| HTTP 服务器 | [srvx](https://srvx.unjs.io) | `serve({ fetch })` 一行启动 |
| CLI | [citty](https://github.com/unjs/citty) | 子命令 `start` / `auth`，声明式 args |
| SSE 解析 | [fetch-event-stream](https://github.com/nicolo-ribaudo/fetch-event-stream) | 将 `Response` 转为 `AsyncIterable<SSEEvent>` |
| 构建 | [tsdown](https://github.com/nicolo-ribaudo/tsdown) | 单文件打包 → `dist/main.mjs`（~70 kB） |
| 日志 | [consola](https://github.com/unjs/consola) | 分级日志，`--verbose` 开启 debug 级别 |

> **零运行时外部依赖**（不依赖 zod、undici、gpt-tokenizer 等）。

---

## 目录结构

```
src/
├── main.ts                         # CLI 入口：定义 start / auth 子命令，启动服务器
├── server.ts                       # Hono app：注册中间件 & 路由
├── lib/
│   ├── api-config.ts               # Copilot / GitHub 请求头、Base URL 构造
│   ├── api-key-auth.ts             # API Key 鉴权中间件
│   ├── error.ts                    # HTTPError 类 + forwardError 统一错误响应
│   ├── paths.ts                    # 应用数据目录（自动探测可写性）
│   ├── rate-limit.ts               # 请求速率限制
│   ├── state.ts                    # 全局可变状态（token、模型缓存、配置…）
│   ├── token.ts                    # GitHub OAuth + Copilot Token 获取 & 刷新
│   └── utils.ts                    # sleep、cacheModels、cacheVSCodeVersion、constantTimeEqual
├── routes/
│   ├── chat-completions/
│   │   └── handler.ts              # POST /chat/completions -> 直接转发
│   ├── responses/
│   │   ├── handler.ts              # POST /responses -> 原生转发 + Stream ID 修复
│   │   ├── stream-id-sync.ts       # 修复 output_item ID 不一致问题
│   │   └── utils.ts                # vision / initiator 检测
│   └── messages/
│       ├── handler.ts              # POST /v1/messages -> 智能路由入口
│       ├── anthropic-types.ts      # Anthropic 协议完整类型定义
│       ├── non-stream-translation.ts   # 请求：Anthropic → OpenAI；响应：OpenAI → Anthropic
│       ├── stream-translation.ts       # 流式：ChatCompletionChunk → Anthropic SSE
│       ├── responses-translation.ts    # 请求：Anthropic → Responses API Payload
│       ├── responses-stream-translation.ts # 流式：Responses Stream → Anthropic SSE
│       ├── responses-utils.ts          # vision / initiator / 有效载荷解析
│       ├── subagent-marker.ts          # __SUBAGENT_MARKER__ 解析
│       └── utils.ts                    # finish_reason 映射
└── services/
    ├── get-vscode-version.ts       # 从 AUR 拉取最新 VS Code 版本号
    ├── copilot/
    │   ├── create-chat-completions.ts  # fetch → Copilot Chat Completions
    │   ├── create-embeddings.ts        # fetch → Copilot Embeddings
    │   ├── create-messages.ts          # fetch → Copilot Messages (Anthropic 原生)
    │   ├── create-responses.ts         # fetch → Copilot Responses API
    │   └── get-models.ts              # fetch → Copilot Models
    └── github/
        ├── get-copilot-token.ts       # GitHub API → Copilot Token
        ├── get-copilot-usage.ts       # GitHub API → 配额用量
        ├── get-device-code.ts         # OAuth Device Flow: 获取 device_code
        ├── get-user.ts                # 获取当前 GitHub 用户信息
        └── poll-access-token.ts       # OAuth Device Flow: 轮询 access_token
```

---

## 启动流程

```
copilot-api start [options]
          │
          ▼
    main.ts (citty)
          │
          ├─ 1. 解析 CLI 参数 → 写入 state
          │     verbose, accountType, rateLimit, apiKeys, smallFastModel ...
          │
          ├─ 2. ensurePaths()
          │     paths.ts → resolveAppDir()
          │     尝试 ~/.local/share/copilot-api（mkdirSync + accessSync W_OK）
          │     失败则回退 os.tmpdir()/copilot-api
          │     确保 github_token 文件存在且权限 0o600
          │
          ├─ 3. cacheVSCodeVersion()
          │     从 AUR PKGBUILD 拉取最新 VS Code 版本号 → state.vsCodeVersion
          │     用于构造 editor-version 请求头，伪装成 VS Code Copilot 插件
          │
          ├─ 4. setupGitHubToken()
          │     读取 ~/.local/share/copilot-api/github_token
          │     若为空 → OAuth Device Flow → 打印 user_code + verification_uri
          │     用户在浏览器完成授权 → poll access_token → 写入文件
          │     → state.githubToken
          │
          ├─ 5. setupCopilotToken()
          │     POST https://api.github.com/copilot_internal/v2/token
          │     → state.copilotToken
          │     → setInterval 自动刷新（refresh_in - 60s）
          │
          ├─ 6. cacheModels()
          │     GET https://api.githubcopilot.com/models
          │     → state.models（包含每个模型的 capabilities、supported_endpoints）
          │
          └─ 7. srvx serve()
                Hono app → HTTP 服务器监听 options.port
```

---

## 全局状态 (State)

`src/lib/state.ts` 导出一个全局单例 `state`，所有模块共享：

```typescript
interface State {
  githubToken?: string       // GitHub OAuth access_token
  copilotToken?: string      // Copilot API JWT（自动刷新）

  accountType: 'individual' | 'business' | 'enterprise'
  models?: ModelsResponse    // 模型列表缓存（含 capabilities / supported_endpoints）
  vsCodeVersion?: string     // 伪装的 VS Code 版本号

  apiKeys?: string[]         // API Key 白名单（空 = 开放模式）
  rateLimitSeconds?: number  // 请求间隔（秒）
  lastRequestTimestamp?: number
  rateLimitWait: boolean     // true = 等待；false = 429

  verbose: boolean
  showToken: boolean
  smallFastModel?: string    // 轻量模型（warmup/compact 请求替换）
}
```

> **设计原则**：不用环境变量、不用配置文件，所有运行时状态归一到此对象。CLI 参数在 `main.ts` 中写入，各模块只读。

---

## 请求生命周期（通用）

不论命中哪个路由，每个请求都经历以下阶段：

```
客户端 HTTP 请求
  │
  ├─ hono/logger       → 打印请求日志
  ├─ hono/cors         → 添加 CORS 头
  ├─ apiKeyAuth        → 校验 API Key（常量时间比较），无 key 配置则跳过
  │
  ├─ 路由 handler
  │   ├─ checkRateLimit()   → 检查请求间隔，超限则等待或抛错
  │   ├─ 解析请求体
  │   ├─ 计费优化预处理     → subagent / compact / warmup / tool_result 合并
  │   ├─ 协议翻译          → Anthropic ↔ OpenAI / Responses 格式转换
  │   ├─ 调用 Copilot API  → fetch + copilotHeaders (伪装 VS Code)
  │   └─ 响应翻译 / 流式转发
  │
  └─ forwardError()    → 统一错误响应格式
```

### 请求头伪装

所有发往 Copilot 后端的请求都携带以下关键头：

```
Authorization: Bearer <copilot_token>
copilot-integration-id: vscode-chat
editor-version: vscode/<version>
editor-plugin-version: copilot-chat/0.37.6
user-agent: GitHubCopilotChat/0.37.6
openai-intent: conversation-agent
x-github-api-version: 2025-10-01
X-Initiator: user | agent          ← 影响计费！
```

`X-Initiator` 决定请求是否消耗 Premium 配额：
- `user`：用户主动发起的请求（消耗 Premium request）
- `agent`：工具调用后自动续接的请求（不消耗 Premium request）

---

## 路由详解

### Chat Completions 路由

**端点**: `POST /chat/completions`、`POST /v1/chat/completions`

```
客户端 (OpenAI 格式)
  │
  ├─ 解析 ChatCompletionsPayload
  ├─ 若 max_tokens 未设置 → 从 state.models 补全
  ├─ createChatCompletions() → fetch Copilot /chat/completions
  │   ├─ 自动检测 vision（image_url）
  │   └─ 自动判断 X-Initiator（最后一条消息角色）
  │
  ├─ 非流式 → c.json(response)
  └─ 流式   → streamSSE → 逐 chunk 转发
```

这是最简单的路由 —— 纯透传，仅补全 `max_tokens` 和构造请求头。

---

### Responses API 路由

**端点**: `POST /responses`、`POST /v1/responses`

```
客户端 (OpenAI Responses 格式)
  │
  ├─ 解析 ResponsesPayload
  ├─ useFunctionApplyPatch()   → custom apply_patch → function 类型
  ├─ removeWebSearchTool()     → 移除 Copilot 不支持的 web_search
  ├─ 检查模型是否支持 /responses 端点
  ├─ createResponses() → fetch Copilot /responses
  │
  ├─ 非流式 → c.json(response)
  └─ 流式   → streamSSE + fixStreamIds()
              │
              └─ Stream ID 同步：
                 Copilot 返回的 output_item.added 和 output_item.done
                 可能有不同的 item.id，这会导致 @ai-sdk/openai 报错。
                 createStreamIdTracker() 记录 added 事件的 ID，
                 在 done 事件中替换回一致的 ID。
```

---

### Anthropic Messages API 路由（智能路由）

**端点**: `POST /v1/messages`

这是最复杂的路由 —— Claude Code 的主要入口。收到 Anthropic 格式请求后，需要根据模型能力选择最优的 Copilot 后端。

#### 路由选择

```
handleMessages()
  │
  ├─ 1. 解析 AnthropicMessagesPayload
  ├─ 2. 计费优化预处理（详见下节）
  │
  ├─ 3. 查找模型 → state.models.data.find(m => m.id === model)
  │
  ├─ 模型的 supported_endpoints 包含 /v1/messages ?
  │   └─ YES → handleWithMessagesApi()     ← 原生 Anthropic 转发
  │
  ├─ 模型的 supported_endpoints 包含 /responses ?
  │   └─ YES → handleWithResponsesApi()   ← 翻译为 Responses API
  │
  └─ 兜底 → handleWithChatCompletions()   ← 翻译为 Chat Completions
```

#### 路径 A: Messages API（原生转发）

```
AnthropicMessagesPayload
  │
  ├─ 过滤无效 thinking 块（签名含 @ 或 thinking="Thinking..."）
  ├─ 若模型支持 adaptive_thinking → 设置 thinking.type = 'adaptive'
  ├─ createMessages() → fetch Copilot /v1/messages
  │   └─ 透传 anthropic-beta 头（过滤 claude-code-specific beta）
  │
  ├─ 非流式 → c.json(response)
  └─ 流式   → 直接透传 SSE 事件
```

#### 路径 B: Responses API

```
AnthropicMessagesPayload
  │
  ├─ translateAnthropicMessagesToResponsesPayload()
  │   ├─ 消息翻译：user/assistant → ResponseInputItem[]
  │   ├─ 工具翻译：AnthropicTool → FunctionTool
  │   ├─ System Prompt 翻译
  │   ├─ Codex 模型 phase 处理（commentary / final_answer）
  │   └─ 设置 reasoning: { effort: 'high', summary: 'detailed' }
  │
  ├─ createResponses() → fetch Copilot /responses
  │
  ├─ 非流式 → translateResponsesResultToAnthropic() → c.json()
  └─ 流式:
       for await (chunk of response):
         translateResponsesStreamEvent(chunk, streamState)
           │
           ├─ response.created       → message_start
           ├─ output_item.added      → content_block_start (tool_use)
           ├─ output_text.delta      → content_block_delta (text_delta)
           ├─ reasoning_summary.*    → content_block_delta (thinking_delta)
           ├─ function_call_args.*   → content_block_delta (input_json_delta)
           ├─ output_item.done       → content_block_stop + signature_delta
           ├─ response.completed     → message_delta + message_stop
           └─ response.failed/error  → error event
```

#### 路径 C: Chat Completions（兜底）

```
AnthropicMessagesPayload
  │
  ├─ translateToOpenAI()
  │   ├─ system → { role: 'system', content: ... }
  │   ├─ user messages:
  │   │   ├─ tool_result → { role: 'tool', tool_call_id, content }
  │   │   └─ text/image  → { role: 'user', content: ContentPart[] }
  │   ├─ assistant messages:
  │   │   ├─ tool_use → tool_calls[]
  │   │   └─ text/thinking → content string
  │   └─ tools: AnthropicTool → OpenAI Tool
  │
  ├─ createChatCompletions() → fetch Copilot /chat/completions
  │
  ├─ 非流式 → translateToAnthropic(response) → c.json()
  └─ 流式:
       for await (chunk of response):
         translateChunkToAnthropicEvents(chunk, streamState)
           │
           ├─ 首个 chunk  → message_start
           ├─ delta.content → content_block_start(text) + content_block_delta(text_delta)
           ├─ delta.tool_calls → content_block_start(tool_use) + input_json_delta
           └─ finish_reason → content_block_stop + message_delta + message_stop

       finish_reason 映射:
         stop → end_turn | length → max_tokens | tool_calls → tool_use
```

---

### 其他路由

| 路由 | 处理 |
|------|------|
| `GET /models` | 返回 `state.models`，格式化为 OpenAI 兼容结构 |
| `POST /embeddings` | 直接转发到 Copilot `/embeddings` |
| `GET /usage` | 调用 GitHub API 获取 Copilot 配额用量 |
| `GET /token` | 返回当前 `state.copilotToken` |
| `GET /` | 健康检查，返回纯文本 |

---

## 计费优化机制

GitHub Copilot 的 Premium 模型（如 Claude Sonnet 4）按 **Premium request** 计费。以下机制可减少不必要的消耗：

### 1. Subagent 标记检测

Claude Code 会在子代理调用时注入 `<system-reminder>...__SUBAGENT_MARKER__...</system-reminder>`。检测到后，将 `X-Initiator` 设为 `agent`，避免以 `user` 身份消耗 Premium 配额。

```
parseSubagentMarkerFromFirstUser(payload)
  → 扫描第一条 user 消息中的 <system-reminder> 标签
  → 包含 __SUBAGENT_MARKER__ → initiator = 'agent'
```

### 2. Compact 请求优化

Claude Code 的 context summarization（上下文压缩）请求以特定 system prompt 开头：

```
"You are a helpful AI assistant tasked with summarizing conversations"
```

检测到后：
- 若设置了 `--small-fast-model` → 使用该模型（如 `gpt-4o-mini`）替代原始高级模型
- 跳过 `tool_result` 合并（compact 请求中不需要）

### 3. Warmup 请求优化

Anthropic beta 请求 + 无 tools = warmup（预热）请求。检测到后：
- 若设置了 `--small-fast-model` → 替换模型

### 4. tool_result 合并

当 user 消息中同时包含 `tool_result` 和 `text` 块时，将 `text` 内容合并进 `tool_result` 的 content。

**目的**：合并后整条消息仅含 `tool_result`，在 Chat Completions 路径下会被翻译为 `role: 'tool'`，Copilot 将其视为 agent 续接而非 user 发起，避免 Premium 计费。

```
合并前：[tool_result, tool_result, text, text]
合并后：[tool_result(含text), tool_result(含text)]  ← 全部为 tool_result
```

### 5. X-Initiator 自动判断

所有发往 Copilot 的请求都自动根据上下文判断 initiator：
- 最后一条消息 role = `user` 且包含非 tool_result 内容 → `user`
- 最后一条消息 role = `assistant` 或 `tool` → `agent`
- subagent marker 优先级最高

---

## 认证体系

### 层级

```
                                    ┌─────────────────────┐
客户端 ──── API Key ────→ copilot-api ──── GitHub Token ────→ GitHub API
                                    │                     │
                                    └── Copilot Token ────→ Copilot API
```

### GitHub OAuth Device Flow

首次使用时触发：

1. `POST github.com/login/device/code` → 获取 `device_code` + `user_code`
2. 用户访问 `https://github.com/login/device` 输入 `user_code`
3. 后台轮询 `POST github.com/login/oauth/access_token`（间隔 interval+1 秒）
4. Access token 写入 `~/.local/share/copilot-api/github_token`（权限 0o600）

### Copilot Token

- 用 GitHub Token 调用 `GET api.github.com/copilot_internal/v2/token`
- 获取 JWT `token` + `refresh_in`（秒）
- 设定定时器在 `(refresh_in - 60)` 秒后自动刷新

### API Key 鉴权

可选功能，通过 `--api-key` 启用：

```
请求到达 → apiKeyAuth 中间件
  │
  ├─ state.apiKeys 为空 → 跳过（开放模式）
  ├─ 提取 key:
  │   ├─ Authorization: Bearer <key>
  │   └─ x-api-key: <key>
  ├─ key 为空 → 401 Missing API key
  └─ constantTimeEqual 逐一比较 → 无匹配 → 401 Invalid API key
```

> 使用常量时间比较 (`constantTimeEqual`) 防止时序攻击。

---

## 文件与路径管理

`src/lib/paths.ts` 负责确定应用数据目录：

```
resolveAppDir()
  │
  ├─ 尝试 ~/.local/share/copilot-api
  │   ├─ mkdirSync(dir, { recursive: true })
  │   └─ accessSync(dir, W_OK)
  │
  ├─ 成功 → 使用该目录
  └─ 失败（权限不足 / 只读文件系统）
      → 回退到 os.tmpdir()/copilot-api
      → consola.warn 提示
```

该目录下存储：
- `github_token` — GitHub OAuth access token

> 结果被缓存，整个进程生命周期只解析一次。

---

## 流式响应处理

### SSE 转发模式

所有流式路由使用 Hono 的 `streamSSE` 辅助函数：

```typescript
return streamSSE(c, async (stream) => {
  for await (const chunk of response) {
    await stream.writeSSE({ event, data })
  }
})
```

### Anthropic SSE 事件序列

Chat Completions → Anthropic 的流式翻译产出以下事件序列：

```
message_start          ← 首个 chunk 触发
content_block_start    ← text 或 tool_use 块开始
content_block_delta    ← text_delta / input_json_delta / thinking_delta / signature_delta
content_block_stop     ← 块结束（finish_reason 或切换块类型时）
message_delta          ← stop_reason + usage
message_stop           ← 结束标记
```

### Stream ID 修复 (Responses API)

`stream-id-sync.ts` 解决 Copilot Responses API 的 ID 不一致问题：

```
output_item.added  →  item.id = "oi_xxx"     ← 记录
...中间事件...     →  item_id = "oi_xxx"     ← 替换为记录的 ID
output_item.done   →  item.id = "oi_yyy"     ← 替换回 "oi_xxx"
```

没有这个修复，`@ai-sdk/openai` 会因为找不到对应的 part 而报错。

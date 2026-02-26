# copilot-api

将你的 GitHub Copilot 订阅转化为 **OpenAI / Anthropic API** 兼容服务器。可无缝对接 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 及任何支持 OpenAI 或 Anthropic 协议的工具。

> [!NOTE]
> [English](./README.md)

## 特性

- **OpenAI 兼容 API** — `POST /chat/completions`、`GET /models`、`POST /embeddings`
- **OpenAI Responses API** — `POST /responses`，原生流式转发，支持 Stream ID 同步
- **Anthropic Messages API** — `POST /v1/messages`，支持流式与非流式
- **智能路由** — 根据模型能力自动选择 Messages API → Responses API → Chat Completions
- **避免重复计费** — Subagent 标记检测、Compact/Warmup 请求优化、tool_result 合并
- **自动 Token 管理** — GitHub OAuth Device Flow 认证 + Copilot Token 自动刷新
- **API Key 认证** — 可选 `--api-key` 参数保护接口（同时支持 `Authorization: Bearer` 和 `x-api-key` 头）
- **Small-Fast-Model** — 可选 `--small-fast-model` 参数，将 warmup/compact 请求路由到轻量模型，节省高级配额
- **速率限制** — 可配置请求间隔
- **多账号类型** — 支持 `individual`、`business`、`enterprise` Copilot 计划
- **Serverless 友好** — 启动时自动检测 home 目录可写性，不可用时自动回退到系统临时目录
- **轻量** — 打包约 70 kB，运行于 Node.js ≥ 24

## 快速开始

### 安装与运行

```bash
# 安装依赖
pnpm install

# 启动服务器（生产模式）
pnpm start

# 或通过 npm 全局安装
npm install -g copilot-api
copilot-api start
```

首次启动时，会引导你通过 GitHub OAuth Device Flow 完成认证。

### 开发

```bash
pnpm run dev                  # 监听模式（tsdown --watch + 自动运行）
pnpm run build                # 使用 tsdown 构建
pnpm run lint                 # ESLint 检查
pnpm run typecheck             # TypeScript 类型检查
```

## 使用方式

### 启动服务器

```bash
copilot-api start [选项]
```

| 选项 | 缩写 | 默认值 | 说明 |
|------|------|--------|------|
| `--port` | `-p` | `4141` | 监听端口 |
| `--verbose` | `-v` | `false` | 启用详细日志 |
| `--account-type` | `-a` | `individual` | Copilot 计划类型（`individual`、`business`、`enterprise`） |
| `--rate-limit` | `-r` | — | 请求最小间隔（秒） |
| `--wait` | `-w` | `false` | 触发速率限制时等待而非报错 |
| `--github-token` | `-g` | — | 直接提供 GitHub Token |
| `--show-token` | | `false` | 在日志中显示 Token |
| `--api-key` | | — | 认证用 API Key（可重复传入多个） |
| `--small-fast-model` | | — | 用于轻量任务（warmup、compact）的模型，节省高级配额 |

### 认证

```bash
# 首次认证（启动服务器时也会自动触发）
copilot-api auth

# 强制重新认证
copilot-api auth --force
```

### API Key 保护

使用一个或多个 API Key 保护你的接口：

```bash
copilot-api start --api-key sk-my-secret-key
copilot-api start --api-key key1 --api-key key2
```

客户端通过以下方式认证：
- `Authorization: Bearer <key>`（OpenAI 兼容格式）
- `x-api-key: <key>`（Anthropic 兼容格式）

未配置 `--api-key` 时，服务器以开放模式运行（无需认证）。

### Small-Fast-Model

将 warmup 和 compact（上下文摘要）请求路由到更经济的模型：

```bash
copilot-api start --small-fast-model gpt-4o-mini
```

设置 `--small-fast-model` 且目标模型可用时，这些轻量请求会使用该模型而非高级模型。未设置时，所有请求使用原始模型。

### 配合 Claude Code 使用

```bash
export ANTHROPIC_BASE_URL=http://localhost:4141
export ANTHROPIC_AUTH_TOKEN=dummy    # 如果设置了 --api-key 则填写对应的 key
claude
```

### API 端点

| 端点 | 方法 | 协议 | 说明 |
|------|------|------|------|
| `/` | GET | — | 健康检查 |
| `/chat/completions` | POST | OpenAI | Chat Completions |
| `/models` | GET | OpenAI | 获取可用模型列表 |
| `/embeddings` | POST | OpenAI | 文本嵌入 |
| `/responses` | POST | OpenAI | Responses API（流式） |
| `/v1/chat/completions` | POST | OpenAI | Chat Completions（v1 前缀） |
| `/v1/models` | GET | OpenAI | 模型列表（v1 前缀） |
| `/v1/embeddings` | POST | OpenAI | 嵌入（v1 前缀） |
| `/v1/responses` | POST | OpenAI | Responses API（v1 前缀） |
| `/v1/messages` | POST | Anthropic | Messages API（流式/非流式） |
| `/usage` | GET | 自定义 | Copilot 配额用量 |
| `/token` | GET | 自定义 | 当前 Copilot Token |

### 配合 OpenCode 使用

```bash
export OPENAI_BASE_URL=http://localhost:4141/v1
export OPENAI_API_KEY=dummy          # 如果设置了 --api-key 则填写对应的 key
opencode
```

## 相比 [ericc-ch/copilot-api](https://github.com/ericc-ch/copilot-api) 的改进

本项目是参考原版 `ericc-ch/copilot-api` 及其 Fork 进行的全新实现。主要改进如下：

### API Key 认证

新增 `--api-key` 选项，防止未授权访问。支持多 Key 配置，兼容 OpenAI（`Bearer`）和 Anthropic（`x-api-key`）两种请求头格式，使用常量时间比较防止时序攻击。未配置 Key 时保持开放模式，向后兼容。

### 精简架构

- 移除手动审批机制（`--manual`）—— 对自动化客户端不实用
- 移除剪贴板集成（`clipboardy`）和交互式模型选择（`--claude-code`）
- 移除 HTTP 代理支持（`undici` / `proxy-from-env`）—— 可在操作系统层面处理
- 移除 Token 计数依赖（`gpt-tokenizer`）—— 减小打包体积
- 不再依赖 `tiny-invariant` 或 `zod` —— 纯 TypeScript 即可满足需求

### 更整洁的代码

- 扁平、精简的文件结构，职责分离清晰
- 所有路由直接在 `server.ts` 中注册，无分散的子路由
- 开箱即用：零 Lint 警告、零类型错误
- 现代工具链：`tsdown` 构建、ESLint flat config

### 更小的打包体积

总打包约 70 kB（原版因 `gpt-tokenizer`、`zod`、`undici` 等依赖而体积明显更大）。

### 智能路由与计费优化

- **自动路由选择** — Messages API 请求自动根据模型能力选择最优后端（Messages API → Responses API → Chat Completions）
- **Subagent 标记检测** — 解析 `__SUBAGENT_MARKER__`，将子代理请求标记为 `user` 发起，避免以 `agent` 身份重复计费
- **Compact/Warmup 优化** — 自动检测上下文摘要和预热请求，设置 `--small-fast-model` 时路由到轻量模型以节省配额
- **tool_result 合并** — 将多个连续 tool_result 自动合并进前一条 assistant 消息，强制使用 Chat Completions（user 发起），避免 agent 级别的 Premium 计费
- **Responses API Stream ID 同步** — 修复 Copilot 流式返回中 `output_item.added` 与 `output_item.done` 的 ID 不一致问题，确保 `@ai-sdk/openai` 等客户端正常工作

## 技术栈

| 组件 | 技术 |
|------|------|
| 运行时 | [Node.js](https://nodejs.org) ≥ 24 |
| Web 框架 | [Hono](https://hono.dev) |
| HTTP 服务器 | [srvx](https://srvx.unjs.io) |
| CLI | [citty](https://github.com/unjs/citty) |
| 构建 | [tsdown](https://github.com/nicolo-ribaudo/tsdown) |
| Lint | [ESLint](https://eslint.org) + [typescript-eslint](https://typescript-eslint.io) |

## 许可证

MIT

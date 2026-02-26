import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  ContentPart,
  Message,
  TextPart,
  Tool,
  ToolCall
} from '~/services/copilot/create-chat-completions'

import type {
  AnthropicAssistantContentBlock,
  AnthropicAssistantMessage,
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicTextBlock,
  AnthropicThinkingBlock,
  AnthropicTool,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
  AnthropicUserContentBlock,
  AnthropicUserMessage
} from './anthropic-types'
import { mapOpenAIStopReasonToAnthropic } from './utils'

// ==========================
// Request: Anthropic → OpenAI
// ==========================

export function translateToOpenAI(payload: AnthropicMessagesPayload): ChatCompletionsPayload {
  return {
    model: translateModelName(payload.model),
    messages: translateMessages(payload.messages, payload.system),
    max_tokens: payload.max_tokens,
    stop: payload.stop_sequences,
    stream: payload.stream,
    temperature: payload.temperature,
    top_p: payload.top_p,
    user: payload.metadata?.user_id,
    tools: translateTools(payload.tools),
    tool_choice: translateToolChoice(payload.tool_choice)
  }
}

function translateModelName(model: string): string {
  if (model.startsWith('claude-sonnet-4-')) return 'claude-sonnet-4'
  if (model.startsWith('claude-opus-4-')) return 'claude-opus-4'
  return model
}

function translateMessages(
  messages: AnthropicMessage[],
  system: string | AnthropicTextBlock[] | undefined
): Message[] {
  const systemMsgs = translateSystem(system)
  const otherMsgs = messages.flatMap((msg) =>
    msg.role === 'user' ? translateUserMessage(msg) : translateAssistantMessage(msg)
  )
  return [...systemMsgs, ...otherMsgs]
}

function translateSystem(system: string | AnthropicTextBlock[] | undefined): Message[] {
  if (!system) return []
  if (typeof system === 'string') return [{ role: 'system', content: system }]
  return [{ role: 'system', content: system.map((b) => b.text).join('\n\n') }]
}

function translateUserMessage(message: AnthropicUserMessage): Message[] {
  if (!Array.isArray(message.content)) {
    return [{ role: 'user', content: mapContent(message.content) }]
  }

  const messages: Message[] = []

  const toolResults = message.content.filter(
    (b): b is AnthropicToolResultBlock => b.type === 'tool_result'
  )
  const otherBlocks = message.content.filter((b) => b.type !== 'tool_result')

  // Tool results must come first: tool_use → tool_result → user
  for (const block of toolResults) {
    messages.push({
      role: 'tool',
      tool_call_id: block.tool_use_id,
      content: typeof block.content === 'string' ? block.content : mapContent(block.content)
    })
  }

  if (otherBlocks.length > 0) {
    messages.push({ role: 'user', content: mapContent(otherBlocks) })
  }

  return messages
}

function translateAssistantMessage(message: AnthropicAssistantMessage): Message[] {
  if (!Array.isArray(message.content)) {
    return [{ role: 'assistant', content: mapContent(message.content) }]
  }

  const toolUseBlocks = message.content.filter(
    (b): b is AnthropicToolUseBlock => b.type === 'tool_use'
  )
  const textBlocks = message.content.filter((b): b is AnthropicTextBlock => b.type === 'text')
  const thinkingBlocks = message.content.filter(
    (b): b is AnthropicThinkingBlock => b.type === 'thinking'
  )

  const allText = [...textBlocks.map((b) => b.text), ...thinkingBlocks.map((b) => b.thinking)].join(
    '\n\n'
  )

  if (toolUseBlocks.length > 0) {
    return [
      {
        role: 'assistant',
        content: allText || null,
        tool_calls: toolUseBlocks.map((tu) => ({
          id: tu.id,
          type: 'function' as const,
          function: {
            name: tu.name,
            arguments: JSON.stringify(tu.input)
          }
        }))
      }
    ]
  }

  return [{ role: 'assistant', content: mapContent(message.content) }]
}

function mapContent(
  content: string | (AnthropicUserContentBlock | AnthropicAssistantContentBlock)[]
): string | ContentPart[] | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null

  const hasImage = content.some((b) => b.type === 'image')
  if (!hasImage) {
    return content
      .filter(
        (b): b is AnthropicTextBlock | AnthropicThinkingBlock =>
          b.type === 'text' || b.type === 'thinking'
      )
      .map((b) => (b.type === 'text' ? b.text : b.thinking))
      .join('\n\n')
  }

  const parts: ContentPart[] = []
  for (const block of content) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text })
    } else if (block.type === 'thinking') {
      parts.push({ type: 'text', text: block.thinking })
    } else if (block.type === 'image') {
      parts.push({
        type: 'image_url',
        image_url: {
          url: `data:${block.source.media_type};base64,${block.source.data}`
        }
      })
    }
  }
  return parts
}

function translateTools(tools: AnthropicTool[] | undefined): Tool[] | undefined {
  if (!tools) return undefined
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema
    }
  }))
}

function translateToolChoice(
  choice: AnthropicMessagesPayload['tool_choice']
): ChatCompletionsPayload['tool_choice'] {
  if (!choice) return undefined
  switch (choice.type) {
    case 'auto':
      return 'auto'
    case 'any':
      return 'required'
    case 'tool':
      return choice.name ? { type: 'function', function: { name: choice.name } } : undefined
    case 'none':
      return 'none'
    default:
      return undefined
  }
}

// ============================
// Response: OpenAI → Anthropic
// ============================

export function translateToAnthropic(response: ChatCompletionResponse): AnthropicResponse {
  const allTextBlocks: AnthropicTextBlock[] = []
  const allToolUseBlocks: AnthropicToolUseBlock[] = []
  let stopReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null =
    response.choices[0]?.finish_reason ?? null

  for (const choice of response.choices) {
    allTextBlocks.push(...getTextBlocks(choice.message.content))
    allToolUseBlocks.push(...getToolUseBlocks(choice.message.tool_calls))

    if (choice.finish_reason === 'tool_calls' || stopReason === 'stop') {
      stopReason = choice.finish_reason
    }
  }

  return {
    id: response.id,
    type: 'message',
    role: 'assistant',
    model: response.model,
    content: [...allTextBlocks, ...allToolUseBlocks],
    stop_reason: mapOpenAIStopReasonToAnthropic(stopReason),
    stop_sequence: null,
    usage: {
      input_tokens:
        (response.usage?.prompt_tokens ?? 0) -
        (response.usage?.prompt_tokens_details?.cached_tokens ?? 0),
      output_tokens: response.usage?.completion_tokens ?? 0,
      ...(response.usage?.prompt_tokens_details?.cached_tokens != null && {
        cache_read_input_tokens: response.usage.prompt_tokens_details.cached_tokens
      })
    }
  }
}

function getTextBlocks(content: Message['content']): AnthropicTextBlock[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }]
  }
  if (Array.isArray(content)) {
    return content
      .filter((p): p is TextPart => p.type === 'text')
      .map((p) => ({ type: 'text', text: p.text }))
  }
  return []
}

function getToolUseBlocks(calls: ToolCall[] | undefined): AnthropicToolUseBlock[] {
  if (!calls) return []
  return calls.map((c) => ({
    type: 'tool_use',
    id: c.id,
    name: c.function.name,
    input: JSON.parse(c.function.arguments) as Record<string, unknown>
  }))
}

import type { Context } from 'hono'

import consola from 'consola'
import { streamSSE } from 'hono/streaming'

import type { Model } from '~/services/copilot/get-models'

import { checkRateLimit } from '~/lib/rate-limit'
import { state } from '~/lib/state'
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse
} from '~/services/copilot/create-chat-completions'
import { createMessages } from '~/services/copilot/create-messages'
import {
  createResponses,
  type ResponsesResult,
  type ResponseStreamEvent
} from '~/services/copilot/create-responses'

import type {
  AnthropicMessagesPayload,
  AnthropicStreamState,
  AnthropicTextBlock,
  AnthropicToolResultBlock
} from './anthropic-types'
import { translateToAnthropic, translateToOpenAI } from './non-stream-translation'
import {
  buildErrorEvent,
  createResponsesStreamState,
  translateResponsesStreamEvent
} from './responses-stream-translation'
import {
  translateAnthropicMessagesToResponsesPayload,
  translateResponsesResultToAnthropic
} from './responses-translation'
import { getResponsesRequestOptions } from './responses-utils'
import { translateChunkToAnthropicEvents } from './stream-translation'
import { parseSubagentMarkerFromFirstUser } from './subagent-marker'

const RESPONSES_ENDPOINT = '/responses'
const MESSAGES_ENDPOINT = '/v1/messages'

const compactSystemPromptStart =
  'You are a helpful AI assistant tasked with summarizing conversations'

// =========================
// Main Handler
// =========================

export async function handleMessages(c: Context) {
  await checkRateLimit()

  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  consola.debug('Anthropic request:', JSON.stringify(anthropicPayload).slice(-400))

  // --- Subagent marker detection (avoid premium billing) ---
  const subagentMarker = parseSubagentMarkerFromFirstUser(anthropicPayload)
  const initiatorOverride = subagentMarker ? 'agent' : undefined
  if (subagentMarker) {
    consola.debug('Detected Subagent marker:', JSON.stringify(subagentMarker))
  }

  // --- Compact request detection (context summarization) ---
  const isCompact = isCompactRequest(anthropicPayload)

  // --- Warmup request detection (anthropic-beta + no tools = warmup) ---
  const anthropicBeta = c.req.header('anthropic-beta')
  const noTools = !anthropicPayload.tools || anthropicPayload.tools.length === 0
  if (anthropicBeta && noTools && !isCompact && state.smallFastModel) {
    anthropicPayload.model = state.smallFastModel
  }

  if (isCompact) {
    consola.debug('Compact request detected')
    if (state.smallFastModel) {
      consola.debug('Using small-fast-model for compact request:', state.smallFastModel)
      anthropicPayload.model = state.smallFastModel
    }
  } else {
    // Merge tool_result + text blocks to avoid consuming premium requests
    mergeToolResultForClaude(anthropicPayload)
  }

  // --- Smart Routing: Messages API > Responses API > Chat Completions ---
  const selectedModel = state.models?.data.find((m) => m.id === anthropicPayload.model)

  if (shouldUseMessagesApi(selectedModel)) {
    return await handleWithMessagesApi(c, anthropicPayload, {
      anthropicBetaHeader: anthropicBeta,
      initiatorOverride,
      selectedModel
    })
  }

  if (shouldUseResponsesApi(selectedModel)) {
    return await handleWithResponsesApi(c, anthropicPayload, initiatorOverride)
  }

  return await handleWithChatCompletions(c, anthropicPayload, initiatorOverride)
}

// =========================
// Route: Chat Completions
// =========================

async function handleWithChatCompletions(
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  initiatorOverride?: 'agent' | 'user'
) {
  const openAIPayload = translateToOpenAI(anthropicPayload)
  consola.debug('Translated OpenAI payload:', JSON.stringify(openAIPayload).slice(-400))

  const response = await createChatCompletions(openAIPayload, {
    initiator: initiatorOverride
  })

  if (isNonStreaming(response)) {
    const anthropicResponse = translateToAnthropic(response)
    return c.json(anthropicResponse)
  }

  return streamSSE(c, async (stream) => {
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      thinkingBlockOpen: false,
      toolCalls: {}
    }

    for await (const rawEvent of response) {
      if (rawEvent.data === '[DONE]') break
      if (!rawEvent.data) continue

      const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
      const events = translateChunkToAnthropicEvents(chunk, streamState)

      for (const event of events) {
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event)
        })
      }
    }
  })
}

// =========================
// Route: Responses API
// =========================

async function handleWithResponsesApi(
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  initiatorOverride?: 'agent' | 'user'
) {
  const responsesPayload = translateAnthropicMessagesToResponsesPayload(anthropicPayload)
  consola.debug('Translated Responses payload:', JSON.stringify(responsesPayload).slice(-400))

  const { vision, initiator } = getResponsesRequestOptions(responsesPayload)
  const response = await createResponses(responsesPayload, {
    vision,
    initiator: initiatorOverride ?? initiator
  })

  if (responsesPayload.stream && isAsyncIterable(response)) {
    consola.debug('Streaming response from Copilot (Responses API)')
    return streamSSE(c, async (stream) => {
      const streamState = createResponsesStreamState()

      for await (const chunk of response) {
        const eventName = chunk.event
        if (eventName === 'ping') {
          await stream.writeSSE({ event: 'ping', data: '{"type":"ping"}' })
          continue
        }

        const data = chunk.data
        if (!data) continue

        const events = translateResponsesStreamEvent(
          JSON.parse(data) as ResponseStreamEvent,
          streamState
        )
        for (const event of events) {
          await stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event)
          })
        }

        if (streamState.messageCompleted) break
      }

      if (!streamState.messageCompleted) {
        consola.warn('Responses stream ended without completion')
        const errorEvent = buildErrorEvent('Responses stream ended without completion')
        await stream.writeSSE({
          event: errorEvent.type,
          data: JSON.stringify(errorEvent)
        })
      }
    })
  }

  const anthropicResponse = translateResponsesResultToAnthropic(response as ResponsesResult)
  return c.json(anthropicResponse)
}

// =========================
// Route: Messages API (native forwarding)
// =========================

async function handleWithMessagesApi(
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  options?: {
    anthropicBetaHeader?: string
    initiatorOverride?: 'agent' | 'user'
    selectedModel?: Model
  }
) {
  const { anthropicBetaHeader, initiatorOverride, selectedModel } = options ?? {}

  // Filter thinking blocks: only keep valid ones for the Messages API
  for (const msg of anthropicPayload.messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      msg.content = msg.content.filter((block) => {
        if (block.type !== 'thinking') return true
        return (
          block.thinking &&
          block.thinking !== 'Thinking...' &&
          block.signature &&
          !block.signature.includes('@')
        )
      })
    }
  }

  // Handle adaptive thinking models
  if (selectedModel?.capabilities.supports.adaptive_thinking) {
    anthropicPayload.thinking = { type: 'adaptive' }
    anthropicPayload.output_config = {
      effort: getAnthropicEffortForModel(anthropicPayload.model)
    }
  }

  consola.debug('Translated Messages payload:', JSON.stringify(anthropicPayload).slice(-400))

  const response = await createMessages(anthropicPayload, anthropicBetaHeader, {
    initiator: initiatorOverride
  })

  if (isAsyncIterable(response)) {
    consola.debug('Streaming response from Copilot (Messages API)')
    return streamSSE(c, async (stream) => {
      for await (const event of response) {
        const eventName = event.event
        const data = event.data ?? ''
        await stream.writeSSE({ event: eventName, data })
      }
    })
  }

  return c.json(response)
}

// =========================
// Routing Logic
// =========================

function shouldUseMessagesApi(selectedModel: Model | undefined): boolean {
  return selectedModel?.supported_endpoints?.includes(MESSAGES_ENDPOINT) ?? false
}

function shouldUseResponsesApi(selectedModel: Model | undefined): boolean {
  return selectedModel?.supported_endpoints?.includes(RESPONSES_ENDPOINT) ?? false
}

// =========================
// Helpers
// =========================

function isNonStreaming(
  response: Awaited<ReturnType<typeof createChatCompletions>>
): response is ChatCompletionResponse {
  return Object.hasOwn(response, 'choices')
}

function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return Boolean(value) && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === 'function'
}

function getAnthropicEffortForModel(_model: string): 'low' | 'medium' | 'high' | 'max' {
  // Default to 'high' reasoning effort for all models
  return 'high'
}

function isCompactRequest(anthropicPayload: AnthropicMessagesPayload): boolean {
  const system = anthropicPayload.system
  if (typeof system === 'string') {
    return system.startsWith(compactSystemPromptStart)
  }
  if (!Array.isArray(system)) return false
  return system.some(
    (msg) => typeof msg.text === 'string' && msg.text.startsWith(compactSystemPromptStart)
  )
}

// --- Merge tool_result + text to avoid premium billing ---

function mergeToolResultForClaude(anthropicPayload: AnthropicMessagesPayload): void {
  for (const msg of anthropicPayload.messages) {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue

    const toolResults: AnthropicToolResultBlock[] = []
    const textBlocks: AnthropicTextBlock[] = []
    let valid = true

    for (const block of msg.content) {
      if (block.type === 'tool_result') {
        toolResults.push(block)
      } else if (block.type === 'text') {
        textBlocks.push(block)
      } else {
        valid = false
        break
      }
    }

    if (!valid || toolResults.length === 0 || textBlocks.length === 0) continue
    msg.content = mergeToolResult(toolResults, textBlocks)
  }
}

function mergeToolResult(
  toolResults: AnthropicToolResultBlock[],
  textBlocks: AnthropicTextBlock[]
): AnthropicToolResultBlock[] {
  if (toolResults.length === textBlocks.length) {
    return toolResults.map((tr, i) => mergeContentWithText(tr, textBlocks[i]))
  }

  // Lengths differ: append all text to last tool_result
  const lastIndex = toolResults.length - 1
  return toolResults.map((tr, i) => (i === lastIndex ? mergeContentWithTexts(tr, textBlocks) : tr))
}

function mergeContentWithText(
  tr: AnthropicToolResultBlock,
  textBlock: AnthropicTextBlock
): AnthropicToolResultBlock {
  if (typeof tr.content === 'string') {
    return { ...tr, content: `${tr.content}\n\n${textBlock.text}` }
  }
  return { ...tr, content: [...tr.content, textBlock] }
}

function mergeContentWithTexts(
  tr: AnthropicToolResultBlock,
  textBlocks: AnthropicTextBlock[]
): AnthropicToolResultBlock {
  if (typeof tr.content === 'string') {
    const appendedTexts = textBlocks.map((tb) => tb.text).join('\n\n')
    return { ...tr, content: `${tr.content}\n\n${appendedTexts}` }
  }
  return { ...tr, content: [...tr.content, ...textBlocks] }
}

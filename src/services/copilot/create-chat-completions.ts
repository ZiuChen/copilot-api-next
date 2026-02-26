import consola from 'consola'
import { events } from 'fetch-event-stream'

import { copilotBaseUrl, copilotHeaders } from '~/lib/api-config'
import { HTTPError } from '~/lib/error'
import { state } from '~/lib/state'

// --- Types ---

export interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | ContentPart[] | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

export interface TextPart {
  type: 'text'
  text: string
}

export interface ImageUrlPart {
  type: 'image_url'
  image_url: { url: string }
}

export type ContentPart = TextPart | ImageUrlPart

export interface Tool {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export interface ChatCompletionsPayload {
  model: string
  messages: Message[]
  max_tokens?: number
  temperature?: number
  top_p?: number
  stream?: boolean
  stop?: string[]
  user?: string
  tools?: Tool[]
  tool_choice?: 'auto' | 'required' | 'none' | { type: 'function'; function: { name: string } }
}

// --- Streaming Response ---

export interface ChatCompletionChunk {
  id: string
  object: 'chat.completion.chunk'
  created: number
  model: string
  choices: ChunkChoice[]
  usage?: UsageInfo
}

interface ChunkChoice {
  index: number
  delta: {
    content?: string | null
    role?: string
    tool_calls?: Array<{
      index: number
      id?: string
      type?: 'function'
      function?: { name?: string; arguments?: string }
    }>
  }
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null
}

// --- Non-streaming Response ---

export interface ChatCompletionResponse {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: Array<{
    index: number
    message: Message
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null
  }>
  usage?: UsageInfo
}

interface UsageInfo {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  prompt_tokens_details?: { cached_tokens: number }
  completion_tokens_details?: {
    accepted_prediction_tokens: number
    rejected_prediction_tokens: number
  }
}

// --- Service ---

export async function createChatCompletions(
  payload: ChatCompletionsPayload,
  options?: { initiator?: 'agent' | 'user' }
) {
  if (!state.copilotToken) throw new Error('Copilot token not found')

  // Detect vision content
  const hasVision = payload.messages.some(
    (msg) => Array.isArray(msg.content) && msg.content.some((part) => part.type === 'image_url')
  )

  // Detect agent calls (last message role determines initiator)
  const lastMsg = payload.messages.at(-1)
  const isAgent =
    options?.initiator === 'agent' ||
    (!options?.initiator && lastMsg != null && ['assistant', 'tool'].includes(lastMsg.role))

  const headers: Record<string, string> = {
    ...copilotHeaders(state, hasVision),
    'X-Initiator': isAgent ? 'agent' : 'user'
  }
  const url = `${copilotBaseUrl(state)}/chat/completions`

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  })

  if (!response.ok) {
    consola.error('Failed to create chat completions', response.status)
    throw new HTTPError('Failed to create chat completions', response)
  }

  if (payload.stream) {
    return events(response)
  }

  return (await response.json()) as ChatCompletionResponse
}

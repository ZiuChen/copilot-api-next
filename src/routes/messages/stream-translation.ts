import type { ChatCompletionChunk } from '~/services/copilot/create-chat-completions'

import type { AnthropicStreamEventData, AnthropicStreamState } from './anthropic-types'
import { mapOpenAIStopReasonToAnthropic } from './utils'

function isToolBlockOpen(s: AnthropicStreamState): boolean {
  if (!s.contentBlockOpen) return false
  return Object.values(s.toolCalls).some((tc) => tc.anthropicBlockIndex === s.contentBlockIndex)
}

export function translateChunkToAnthropicEvents(
  chunk: ChatCompletionChunk,
  s: AnthropicStreamState
): AnthropicStreamEventData[] {
  const events: AnthropicStreamEventData[] = []

  if (chunk.choices.length === 0) return events

  const choice = chunk.choices[0]!
  const { delta } = choice

  // --- message_start ---
  if (!s.messageStartSent) {
    events.push({
      type: 'message_start',
      message: {
        id: chunk.id,
        type: 'message',
        role: 'assistant',
        content: [],
        model: chunk.model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens:
            (chunk.usage?.prompt_tokens ?? 0) -
            (chunk.usage?.prompt_tokens_details?.cached_tokens ?? 0),
          output_tokens: 0,
          ...(chunk.usage?.prompt_tokens_details?.cached_tokens != null && {
            cache_read_input_tokens: chunk.usage.prompt_tokens_details.cached_tokens
          })
        }
      }
    })
    s.messageStartSent = true
  }

  // --- text delta ---
  if (delta.content) {
    if (isToolBlockOpen(s)) {
      events.push({ type: 'content_block_stop', index: s.contentBlockIndex })
      s.contentBlockIndex++
      s.contentBlockOpen = false
    }

    if (!s.contentBlockOpen) {
      events.push({
        type: 'content_block_start',
        index: s.contentBlockIndex,
        content_block: { type: 'text', text: '' }
      })
      s.contentBlockOpen = true
    }

    events.push({
      type: 'content_block_delta',
      index: s.contentBlockIndex,
      delta: { type: 'text_delta', text: delta.content }
    })
  }

  // --- tool_calls delta ---
  if (delta.tool_calls) {
    for (const toolCall of delta.tool_calls) {
      if (toolCall.id && toolCall.function?.name) {
        // New tool call starting
        if (s.contentBlockOpen) {
          events.push({
            type: 'content_block_stop',
            index: s.contentBlockIndex
          })
          s.contentBlockIndex++
          s.contentBlockOpen = false
        }

        const blockIndex = s.contentBlockIndex
        s.toolCalls[toolCall.index] = {
          id: toolCall.id,
          name: toolCall.function.name,
          anthropicBlockIndex: blockIndex
        }

        events.push({
          type: 'content_block_start',
          index: blockIndex,
          content_block: {
            type: 'tool_use',
            id: toolCall.id,
            name: toolCall.function.name,
            input: {}
          }
        })
        s.contentBlockOpen = true
      }

      if (toolCall.function?.arguments) {
        const info = s.toolCalls[toolCall.index]
        if (info) {
          events.push({
            type: 'content_block_delta',
            index: info.anthropicBlockIndex,
            delta: {
              type: 'input_json_delta',
              partial_json: toolCall.function.arguments
            }
          })
        }
      }
    }
  }

  // --- finish ---
  if (choice.finish_reason) {
    if (s.contentBlockOpen) {
      events.push({ type: 'content_block_stop', index: s.contentBlockIndex })
      s.contentBlockOpen = false
    }

    events.push(
      {
        type: 'message_delta',
        delta: {
          stop_reason: mapOpenAIStopReasonToAnthropic(choice.finish_reason),
          stop_sequence: null
        },
        usage: {
          input_tokens:
            (chunk.usage?.prompt_tokens ?? 0) -
            (chunk.usage?.prompt_tokens_details?.cached_tokens ?? 0),
          output_tokens: chunk.usage?.completion_tokens ?? 0,
          ...(chunk.usage?.prompt_tokens_details?.cached_tokens != null && {
            cache_read_input_tokens: chunk.usage.prompt_tokens_details.cached_tokens
          })
        }
      },
      { type: 'message_stop' }
    )
  }

  return events
}

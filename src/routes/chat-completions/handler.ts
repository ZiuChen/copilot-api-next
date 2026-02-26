import type { Context } from 'hono'

import consola from 'consola'
import { streamSSE, type SSEMessage } from 'hono/streaming'

import { checkRateLimit } from '~/lib/rate-limit'
import { state } from '~/lib/state'
import { isNullish } from '~/lib/utils'
import {
  createChatCompletions,
  type ChatCompletionResponse,
  type ChatCompletionsPayload
} from '~/services/copilot/create-chat-completions'

export async function handleChatCompletion(c: Context) {
  await checkRateLimit()

  const payload = await c.req.json<ChatCompletionsPayload>()
  consola.debug('Chat completion request:', JSON.stringify(payload).slice(-400))

  // Auto-fill max_tokens from model capabilities
  const selectedModel = state.models?.data.find((m) => m.id === payload.model)

  let finalPayload = payload
  if (isNullish(payload.max_tokens) && selectedModel) {
    finalPayload = {
      ...payload,
      max_tokens: selectedModel.capabilities.limits.max_output_tokens
    }
  }

  const response = await createChatCompletions(finalPayload)

  if (isNonStreaming(response)) {
    return c.json(response)
  }

  return streamSSE(c, async (stream) => {
    for await (const chunk of response) {
      await stream.writeSSE(chunk as SSEMessage)
    }
  })
}

function isNonStreaming(
  response: Awaited<ReturnType<typeof createChatCompletions>>
): response is ChatCompletionResponse {
  return Object.hasOwn(response, 'choices')
}

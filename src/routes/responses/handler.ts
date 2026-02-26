import type { Context } from 'hono'

import consola from 'consola'
import { streamSSE } from 'hono/streaming'

import { checkRateLimit } from '~/lib/rate-limit'
import { state } from '~/lib/state'
import {
  createResponses,
  type ResponsesPayload,
  type ResponsesResult
} from '~/services/copilot/create-responses'

import { createStreamIdTracker, fixStreamIds } from './stream-id-sync'
import { getResponsesRequestOptions } from './utils'

const RESPONSES_ENDPOINT = '/responses'

export async function handleResponses(c: Context) {
  await checkRateLimit()

  const payload = await c.req.json<ResponsesPayload>()
  consola.debug('Responses request payload:', JSON.stringify(payload).slice(-400))

  useFunctionApplyPatch(payload)
  removeWebSearchTool(payload)

  const selectedModel = state.models?.data.find((model) => model.id === payload.model)
  const supportsResponses =
    selectedModel?.supported_endpoints?.includes(RESPONSES_ENDPOINT) ?? false

  if (!supportsResponses) {
    return c.json(
      {
        error: {
          message:
            'This model does not support the responses endpoint. Please choose a different model.',
          type: 'invalid_request_error'
        }
      },
      400
    )
  }

  const { vision, initiator } = getResponsesRequestOptions(payload)

  const response = await createResponses(payload, { vision, initiator })

  if (isStreamingRequested(payload) && isAsyncIterable(response)) {
    consola.debug('Forwarding native Responses stream')
    return streamSSE(c, async (stream) => {
      const idTracker = createStreamIdTracker()

      for await (const chunk of response) {
        const processedData = fixStreamIds(
          (chunk as { data?: string }).data ?? '',
          (chunk as { event?: string }).event,
          idTracker
        )

        await stream.writeSSE({
          id: (chunk as { id?: string }).id,
          event: (chunk as { event?: string }).event,
          data: processedData
        })
      }
    })
  }

  consola.debug('Forwarding native Responses result:', JSON.stringify(response).slice(-400))
  return c.json(response as ResponsesResult)
}

function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return Boolean(value) && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === 'function'
}

function isStreamingRequested(payload: ResponsesPayload): boolean {
  return Boolean(payload.stream)
}

/**
 * Converts custom `apply_patch` tools to function tools for Copilot compatibility.
 * Always enabled — Copilot does not support custom tool types.
 */
function useFunctionApplyPatch(payload: ResponsesPayload): void {
  if (Array.isArray(payload.tools)) {
    for (let i = 0; i < payload.tools.length; i++) {
      const t = payload.tools[i] as Record<string, unknown>
      if (t.type === 'custom' && t.name === 'apply_patch') {
        payload.tools[i] = {
          type: 'function',
          name: t.name as string,
          description: 'Use the `apply_patch` tool to edit files',
          parameters: {
            type: 'object',
            properties: {
              input: {
                type: 'string',
                description: 'The entire contents of the apply_patch command'
              }
            },
            required: ['input']
          },
          strict: false
        }
      }
    }
  }
}

/**
 * Removes web_search tools which are not supported by GitHub Copilot.
 */
function removeWebSearchTool(payload: ResponsesPayload): void {
  if (!Array.isArray(payload.tools) || payload.tools.length === 0) return

  payload.tools = payload.tools.filter((t) => {
    return (t as Record<string, unknown>).type !== 'web_search'
  })
}

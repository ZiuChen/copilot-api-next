import type { MiddlewareHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'

import { state } from './state'
import { constantTimeEqual } from './utils'

/**
 * Extract API key from request headers.
 * Supports both OpenAI format (Authorization: Bearer <key>)
 * and Anthropic format (x-api-key: <key>).
 */
function extractApiKey(authHeader?: string, xApiKey?: string): string | undefined {
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7)
  }
  if (xApiKey) {
    return xApiKey
  }
  return undefined
}

/**
 * Middleware that validates API key if configured.
 * When no API keys are configured, all requests pass through (open mode).
 */
export const apiKeyAuth: MiddlewareHandler = async (c, next) => {
  if (!state.apiKeys || state.apiKeys.length === 0) {
    await next()
    return
  }

  const providedKey = extractApiKey(c.req.header('authorization'), c.req.header('x-api-key'))

  if (!providedKey) {
    throw new HTTPException(401, { message: 'Missing API key' })
  }

  const isValid = state.apiKeys.some((key) => constantTimeEqual(key, providedKey))

  if (!isValid) {
    throw new HTTPException(401, { message: 'Invalid API key' })
  }

  await next()
}

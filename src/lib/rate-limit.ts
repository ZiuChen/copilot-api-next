import consola from 'consola'

import { state } from './state'

export async function checkRateLimit(): Promise<void> {
  if (!state.rateLimitSeconds) return

  const now = Date.now()
  const elapsed = now - (state.lastRequestTimestamp ?? 0)
  const waitMs = state.rateLimitSeconds * 1000

  if (elapsed < waitMs) {
    const remaining = waitMs - elapsed
    if (state.rateLimitWait) {
      consola.info(`Rate limit: waiting ${remaining}ms`)
      await new Promise<void>((resolve) => setTimeout(resolve, remaining))
    } else {
      throw new Error(`Rate limit exceeded. Try again in ${Math.ceil(remaining / 1000)}s`)
    }
  }

  state.lastRequestTimestamp = Date.now()
}

import type { AnthropicMessagesPayload } from './anthropic-types'

/**
 * Parses the __SUBAGENT_MARKER__ from the first user message in an Anthropic payload.
 *
 * Claude Code and other agentic tools inject a marker like:
 *   <system-reminder>...__SUBAGENT_MARKER__...</system-reminder>
 *
 * When detected, this indicates the request is a sub-agent call which should
 * use the "agent" initiator to avoid consuming premium request credits.
 */

const SUBAGENT_MARKER = '__SUBAGENT_MARKER__'
const SYSTEM_REMINDER_REGEX = /<system-reminder>([\s\S]*?)<\/system-reminder>/

export function parseSubagentMarkerFromFirstUser(payload: AnthropicMessagesPayload): string | null {
  const firstUserMessage = payload.messages.find((m) => m.role === 'user')
  if (!firstUserMessage) return null

  const { content } = firstUserMessage
  if (typeof content === 'string') {
    return extractMarker(content)
  }

  if (!Array.isArray(content)) return null

  for (const block of content) {
    if (block.type === 'text') {
      const marker = extractMarker(block.text)
      if (marker) return marker
    }
  }

  return null
}

function extractMarker(text: string): string | null {
  if (!text.includes(SUBAGENT_MARKER)) return null

  const match = SYSTEM_REMINDER_REGEX.exec(text)
  if (!match) return null

  const reminderContent = match[1]
  if (reminderContent.includes(SUBAGENT_MARKER)) {
    return SUBAGENT_MARKER
  }

  return null
}

import type { AnthropicResponse } from './anthropic-types'

type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | null

const STOP_REASON_MAP: Record<string, AnthropicResponse['stop_reason']> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  content_filter: 'end_turn'
}

export function mapOpenAIStopReasonToAnthropic(
  finishReason: FinishReason
): AnthropicResponse['stop_reason'] {
  if (finishReason === null) return null
  return STOP_REASON_MAP[finishReason] ?? null
}

import type { ResponseInputItem, ResponsesPayload } from '~/services/copilot/create-responses'

export function getResponsesRequestOptions(payload: ResponsesPayload): {
  vision: boolean
  initiator: 'agent' | 'user'
} {
  const vision = hasVisionInput(payload)
  const initiator = hasAgentInitiator(payload) ? 'agent' : 'user'
  return { vision, initiator }
}

function hasAgentInitiator(payload: ResponsesPayload): boolean {
  // Only check the last item to avoid incorrectly flagging user messages
  // from previous assistant history as agent calls
  const lastItem = getPayloadItems(payload).at(-1)
  if (!lastItem) return false
  if (!('role' in lastItem) || !lastItem.role) return true

  const role = typeof lastItem.role === 'string' ? lastItem.role.toLowerCase() : ''
  return role === 'assistant'
}

function hasVisionInput(payload: ResponsesPayload): boolean {
  return getPayloadItems(payload).some((item) => containsVisionContent(item))
}

function getPayloadItems(payload: ResponsesPayload): ResponseInputItem[] {
  if (Array.isArray(payload.input)) return payload.input
  return []
}

function containsVisionContent(value: unknown): boolean {
  if (!value) return false

  if (Array.isArray(value)) {
    return value.some((entry) => containsVisionContent(entry))
  }

  if (typeof value !== 'object') return false

  const record = value as Record<string, unknown>
  const type = typeof record.type === 'string' ? record.type.toLowerCase() : undefined

  if (type === 'input_image') return true

  if (Array.isArray(record.content)) {
    return record.content.some((entry) => containsVisionContent(entry))
  }

  return false
}

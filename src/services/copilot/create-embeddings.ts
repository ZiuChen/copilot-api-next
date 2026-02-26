import { copilotBaseUrl, copilotHeaders } from '~/lib/api-config'
import { HTTPError } from '~/lib/error'
import { state } from '~/lib/state'

// --- Types ---

export interface EmbeddingRequest {
  input: string | string[]
  model: string
}

export interface EmbeddingResponse {
  object: string
  data: Array<{ object: string; embedding: number[]; index: number }>
  model: string
  usage: { prompt_tokens: number; total_tokens: number }
}

// --- Service ---

export async function createEmbeddings(payload: EmbeddingRequest): Promise<EmbeddingResponse> {
  if (!state.copilotToken) throw new Error('Copilot token not found')

  const response = await fetch(`${copilotBaseUrl(state)}/embeddings`, {
    method: 'POST',
    headers: copilotHeaders(state),
    body: JSON.stringify(payload)
  })

  if (!response.ok) {
    throw new HTTPError('Failed to create embeddings', response)
  }

  return (await response.json()) as EmbeddingResponse
}

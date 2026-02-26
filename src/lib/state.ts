import type { ModelsResponse } from '~/services/copilot/get-models'

export interface State {
  githubToken?: string
  copilotToken?: string

  accountType: 'individual' | 'business' | 'enterprise'
  models?: ModelsResponse
  vsCodeVersion?: string

  // API key authentication
  apiKeys?: string[]

  // Rate limiting
  rateLimitSeconds?: number
  lastRequestTimestamp?: number
  rateLimitWait: boolean

  // Feature flags
  verbose: boolean
  showToken: boolean

  // Small/fast model for lightweight tasks (warmup, compact)
  smallFastModel?: string
}

export const state: State = {
  accountType: 'individual',
  rateLimitWait: false,
  verbose: false,
  showToken: false
}

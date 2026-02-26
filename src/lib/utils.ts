import consola from 'consola'

import { getModels } from '~/services/copilot/get-models'
import { getVSCodeVersion } from '~/services/get-vscode-version'

import { state } from './state'

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export const isNullish = (value: unknown): value is null | undefined =>
  value === null || value === undefined

export async function cacheModels(): Promise<void> {
  const models = await getModels()
  state.models = models
}

export async function cacheVSCodeVersion(): Promise<void> {
  const version = await getVSCodeVersion()
  state.vsCodeVersion = version
  consola.info(`Using VSCode version: ${version}`)
}

/**
 * Constant-time string comparison to prevent timing attacks.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let result = 0
  for (let i = 0; i < a.length; i++) {
    result |= (a.codePointAt(i) ?? 0) ^ (b.codePointAt(i) ?? 0)
  }
  return result === 0
}

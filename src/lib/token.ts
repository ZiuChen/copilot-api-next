import fs from 'node:fs/promises'

import consola from 'consola'

import { PATHS } from '~/lib/paths'
import { state } from '~/lib/state'
import { getCopilotToken } from '~/services/github/get-copilot-token'
import { getDeviceCode } from '~/services/github/get-device-code'
import { getGitHubUser } from '~/services/github/get-user'
import { pollAccessToken } from '~/services/github/poll-access-token'

import { HTTPError } from './error'

// --- GitHub Token ---

const readGithubToken = () => fs.readFile(PATHS.GITHUB_TOKEN_PATH, 'utf8')
const writeGithubToken = (token: string) => fs.writeFile(PATHS.GITHUB_TOKEN_PATH, token)

export async function setupGitHubToken(options?: { force?: boolean }): Promise<void> {
  try {
    const githubToken = await readGithubToken()

    if (githubToken && !options?.force) {
      state.githubToken = githubToken
      if (state.showToken) consola.info('GitHub token:', githubToken)
      await logUser()
      return
    }

    consola.info('Not logged in, starting GitHub OAuth Device Flow...')
    const response = await getDeviceCode()

    consola.info(`Please enter the code "${response.user_code}" at ${response.verification_uri}`)

    const token = await pollAccessToken(response)
    await writeGithubToken(token)
    state.githubToken = token

    if (state.showToken) consola.info('GitHub token:', token)
    await logUser()
  } catch (error) {
    if (error instanceof HTTPError) {
      consola.error('Failed to get GitHub token:', await error.response.json())
    } else {
      consola.error('Failed to get GitHub token:', error)
    }
    throw error
  }
}

// --- Copilot Token ---

export async function setupCopilotToken(): Promise<void> {
  const { token, refresh_in } = await getCopilotToken()
  state.copilotToken = token

  consola.debug('Copilot token fetched successfully')
  if (state.showToken) consola.info('Copilot token:', token)

  // Auto-refresh: refresh_in is in seconds, refresh 60s before expiry
  const refreshInterval = (refresh_in - 60) * 1000
  setInterval(async () => {
    consola.debug('Refreshing Copilot token...')
    try {
      const { token } = await getCopilotToken()
      state.copilotToken = token
      consola.debug('Copilot token refreshed')
      if (state.showToken) consola.info('Refreshed Copilot token:', token)
    } catch (error) {
      consola.error('Failed to refresh Copilot token:', error)
    }
  }, refreshInterval)
}

// --- Helpers ---

async function logUser(): Promise<void> {
  const user = await getGitHubUser()
  consola.info(`Logged in as ${user.login}`)
}

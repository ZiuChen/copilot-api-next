import { GITHUB_API_BASE_URL, githubHeaders } from '~/lib/api-config'
import { state } from '~/lib/state'

export async function getCopilotUsage(): Promise<unknown> {
  const response = await fetch(`${GITHUB_API_BASE_URL}/copilot_internal/user`, {
    headers: githubHeaders(state)
  })

  if (!response.ok) {
    throw new Error('Failed to get Copilot usage')
  }

  return response.json()
}

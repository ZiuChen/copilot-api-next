import { GITHUB_API_BASE_URL, githubHeaders } from '~/lib/api-config'
import { state } from '~/lib/state'

interface GitHubUser {
  login: string
  id: number
  name: string | null
}

export async function getGitHubUser(): Promise<GitHubUser> {
  const response = await fetch(`${GITHUB_API_BASE_URL}/user`, {
    headers: githubHeaders(state)
  })

  if (!response.ok) {
    throw new Error('Failed to get GitHub user')
  }

  return (await response.json()) as GitHubUser
}

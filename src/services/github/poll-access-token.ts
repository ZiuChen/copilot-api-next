import consola from 'consola'

import { GITHUB_BASE_URL, GITHUB_CLIENT_ID, standardHeaders } from '~/lib/api-config'
import { sleep } from '~/lib/utils'

import type { DeviceCodeResponse } from './get-device-code'

interface AccessTokenResponse {
  access_token: string
  token_type: string
  scope: string
}

export async function pollAccessToken(deviceCode: DeviceCodeResponse): Promise<string> {
  const sleepDuration = (deviceCode.interval + 1) * 1000

  while (true) {
    const response = await fetch(`${GITHUB_BASE_URL}/login/oauth/access_token`, {
      method: 'POST',
      headers: standardHeaders(),
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        device_code: deviceCode.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
      })
    })

    if (!response.ok) {
      consola.error('Failed to poll access token:', await response.text())
      await sleep(sleepDuration)
      continue
    }

    const json = (await response.json()) as AccessTokenResponse

    if (json.access_token) {
      return json.access_token
    }

    await sleep(sleepDuration)
  }
}

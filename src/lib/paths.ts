import fsAsync from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import consola from 'consola'

function resolveAppDir(): string {
  try {
    const home = os.homedir()
    const dir = path.join(home, '.local', 'share', 'copilot-api')
    fsSync.mkdirSync(dir, { recursive: true })
    fsSync.accessSync(dir, fsSync.constants.W_OK)
    return dir
  } catch {
    // Serverless / read-only filesystem — fall back to OS temp dir
    const fallback = path.join(os.tmpdir(), 'copilot-api')
    consola.warn(`Home directory not writable, falling back to ${fallback}`)
    return fallback
  }
}

let _appDir: string | undefined

function getAppDir(): string {
  _appDir ??= resolveAppDir()
  return _appDir
}

export const PATHS = {
  get APP_DIR() {
    return getAppDir()
  },
  get GITHUB_TOKEN_PATH() {
    return path.join(getAppDir(), 'github_token')
  }
}

export async function ensurePaths(): Promise<void> {
  await fsAsync.mkdir(PATHS.APP_DIR, { recursive: true })
  try {
    await fsAsync.access(PATHS.GITHUB_TOKEN_PATH, fsAsync.constants.W_OK)
  } catch {
    await fsAsync.writeFile(PATHS.GITHUB_TOKEN_PATH, '')
    await fsAsync.chmod(PATHS.GITHUB_TOKEN_PATH, 0o600)
  }
}

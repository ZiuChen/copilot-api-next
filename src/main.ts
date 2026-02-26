import { defineCommand, runMain } from 'citty'
import consola from 'consola'
import { serve, type ServerHandler } from 'srvx'

import { ensurePaths } from './lib/paths'
import { state } from './lib/state'
import { setupCopilotToken, setupGitHubToken } from './lib/token'
import { cacheModels, cacheVSCodeVersion } from './lib/utils'
import { app } from './server'

// =============================
// start subcommand
// =============================

interface RunServerOptions {
  port: number
  verbose: boolean
  accountType: 'individual' | 'business' | 'enterprise'
  rateLimit?: number
  rateLimitWait: boolean
  githubToken?: string
  showToken: boolean
  apiKeys?: string[]
  smallFastModel?: string
}

async function runServer(options: RunServerOptions): Promise<void> {
  if (options.verbose) {
    consola.level = 5
    consola.info('Verbose logging enabled')
  }

  state.accountType = options.accountType
  state.rateLimitSeconds = options.rateLimit
  state.rateLimitWait = options.rateLimitWait
  state.showToken = options.showToken
  state.verbose = options.verbose

  // API key auth
  if (options.apiKeys && options.apiKeys.length > 0) {
    state.apiKeys = options.apiKeys
    consola.info(`API key authentication enabled with ${options.apiKeys.length} key(s)`)
  }

  // Small/fast model for lightweight tasks
  if (options.smallFastModel) {
    state.smallFastModel = options.smallFastModel
    consola.info(`Small-fast-model: ${options.smallFastModel}`)
  }

  await ensurePaths()
  await cacheVSCodeVersion()

  // GitHub token: use provided or go through OAuth
  if (options.githubToken) {
    state.githubToken = options.githubToken
    consola.info('Using provided GitHub token')
  } else {
    await setupGitHubToken()
  }

  await setupCopilotToken()
  await cacheModels()

  consola.info(`Available models:\n${state.models?.data.map((m) => `  - ${m.id}`).join('\n')}`)

  serve({
    fetch: app.fetch as ServerHandler,
    port: options.port
  })

  consola.success(`Server listening on http://localhost:${options.port}`)
}

const start = defineCommand({
  meta: {
    name: 'start',
    description: 'Start the Copilot API server'
  },
  args: {
    port: {
      alias: 'p',
      type: 'string',
      default: '4141',
      description: 'Port to listen on'
    },
    verbose: {
      alias: 'v',
      type: 'boolean',
      default: false,
      description: 'Enable verbose logging'
    },
    'account-type': {
      alias: 'a',
      type: 'string',
      default: 'individual',
      description: 'Account type (individual, business, enterprise)'
    },
    'rate-limit': {
      alias: 'r',
      type: 'string',
      description: 'Rate limit in seconds between requests'
    },
    wait: {
      alias: 'w',
      type: 'boolean',
      default: false,
      description: 'Wait instead of error when rate limit is hit'
    },
    'github-token': {
      alias: 'g',
      type: 'string',
      description: 'Provide GitHub token directly'
    },
    'show-token': {
      type: 'boolean',
      default: false,
      description: 'Show tokens in log output'
    },
    'api-key': {
      type: 'string',
      description: 'API key(s) for authentication. Repeat for multiple keys.'
    },
    'small-fast-model': {
      type: 'string',
      description:
        'Model name for lightweight tasks (warmup, compact). When set and available, saves premium quota.'
    }
  },
  run({ args }) {
    const rateLimitRaw = args['rate-limit']
    const rateLimit = rateLimitRaw === undefined ? undefined : Number.parseInt(rateLimitRaw, 10)

    // Support multiple --api-key flags (citty aggregates to array)
    const apiKeyRaw = args['api-key']
    let apiKeys: string[] | undefined
    if (apiKeyRaw) {
      apiKeys = Array.isArray(apiKeyRaw) ? apiKeyRaw : [apiKeyRaw]
    }

    return runServer({
      port: Number.parseInt(args.port, 10),
      verbose: args.verbose,
      accountType: args['account-type'] as RunServerOptions['accountType'],
      rateLimit,
      rateLimitWait: args.wait,
      githubToken: args['github-token'],
      showToken: args['show-token'],
      apiKeys,
      smallFastModel: args['small-fast-model']
    })
  }
})

// =============================
// auth subcommand
// =============================

const auth = defineCommand({
  meta: {
    name: 'auth',
    description: 'Authenticate with GitHub (OAuth Device Flow)'
  },
  args: {
    force: {
      alias: 'f',
      type: 'boolean',
      default: false,
      description: 'Force re-authentication'
    }
  },
  async run({ args }) {
    await ensurePaths()
    await cacheVSCodeVersion()
    await setupGitHubToken({ force: args.force })
    consola.success('Authentication complete!')
  }
})

// =============================
// main
// =============================

const main = defineCommand({
  meta: {
    name: 'copilot-api',
    description: 'Turn GitHub Copilot into an OpenAI/Anthropic API compatible server',
    version: '1.0.0'
  },
  subCommands: {
    start,
    auth
  }
})

runMain(main)

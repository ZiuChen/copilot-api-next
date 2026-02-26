import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'

import { apiKeyAuth } from './lib/api-key-auth'
import { forwardError } from './lib/error'
import { state } from './lib/state'
import { cacheModels } from './lib/utils'
import { handleChatCompletion } from './routes/chat-completions/handler'
import { handleMessages } from './routes/messages/handler'
import { handleResponses } from './routes/responses/handler'
import { createEmbeddings, type EmbeddingRequest } from './services/copilot/create-embeddings'
import { getCopilotUsage } from './services/github/get-copilot-usage'

export const app = new Hono()

// --- Global Middleware ---
app.use(logger())
app.use(cors())

// --- API Key Auth (applied to all API routes) ---
app.use('/chat/completions', apiKeyAuth)
app.use('/models', apiKeyAuth)
app.use('/embeddings', apiKeyAuth)
app.use('/usage', apiKeyAuth)
app.use('/token', apiKeyAuth)
app.use('/responses', apiKeyAuth)
app.use('/v1/chat/completions', apiKeyAuth)
app.use('/v1/models', apiKeyAuth)
app.use('/v1/embeddings', apiKeyAuth)
app.use('/v1/messages/*', apiKeyAuth)
app.use('/v1/responses', apiKeyAuth)

// --- Health Check ---
app.get('/', (c) => c.text('copilot-api-next is running'))

// --- Chat Completions (OpenAI compatible) ---
app.post('/chat/completions', async (c) => {
  try {
    return await handleChatCompletion(c)
  } catch (error) {
    return await forwardError(c, error)
  }
})

// --- Models ---
app.get('/models', async (c) => {
  try {
    if (!state.models) await cacheModels()

    const models = state.models?.data.map((m) => ({
      id: m.id,
      object: 'model',
      type: 'model',
      created: 0,
      created_at: new Date(0).toISOString(),
      owned_by: m.vendor,
      display_name: m.name
    }))

    return c.json({ object: 'list', data: models, has_more: false })
  } catch (error) {
    return await forwardError(c, error)
  }
})

// --- Embeddings ---
app.post('/embeddings', async (c) => {
  try {
    const payload = await c.req.json<EmbeddingRequest>()
    return c.json(await createEmbeddings(payload))
  } catch (error) {
    return await forwardError(c, error)
  }
})

// --- Usage ---
app.get('/usage', async (c) => {
  try {
    return c.json(await getCopilotUsage())
  } catch (error) {
    return await forwardError(c, error)
  }
})

// --- Token ---
app.get('/token', (c) => {
  return c.json({ token: state.copilotToken ?? null })
})

// --- v1/ prefix compatibility ---
app.post('/v1/chat/completions', async (c) => {
  try {
    return await handleChatCompletion(c)
  } catch (error) {
    return await forwardError(c, error)
  }
})

app.get('/v1/models', async (c) => {
  try {
    if (!state.models) await cacheModels()

    const models = state.models?.data.map((m) => ({
      id: m.id,
      object: 'model',
      type: 'model',
      created: 0,
      created_at: new Date(0).toISOString(),
      owned_by: m.vendor,
      display_name: m.name
    }))

    return c.json({ object: 'list', data: models, has_more: false })
  } catch (error) {
    return await forwardError(c, error)
  }
})

app.post('/v1/embeddings', async (c) => {
  try {
    const payload = await c.req.json<EmbeddingRequest>()
    return c.json(await createEmbeddings(payload))
  } catch (error) {
    return await forwardError(c, error)
  }
})

// --- Anthropic Messages API compatible ---
app.post('/v1/messages', async (c) => {
  try {
    return await handleMessages(c)
  } catch (error) {
    return await forwardError(c, error)
  }
})

// --- OpenAI Responses API ---
app.post('/responses', async (c) => {
  try {
    return await handleResponses(c)
  } catch (error) {
    return await forwardError(c, error)
  }
})

app.post('/v1/responses', async (c) => {
  try {
    return await handleResponses(c)
  } catch (error) {
    return await forwardError(c, error)
  }
})

import {
  type ResponseCompletedEvent,
  type ResponseCreatedEvent,
  type ResponseErrorEvent,
  type ResponseFailedEvent,
  type ResponseFunctionCallArgumentsDeltaEvent,
  type ResponseFunctionCallArgumentsDoneEvent,
  type ResponseIncompleteEvent,
  type ResponseOutputItemAddedEvent,
  type ResponseOutputItemDoneEvent,
  type ResponseReasoningSummaryTextDeltaEvent,
  type ResponseReasoningSummaryTextDoneEvent,
  type ResponsesResult,
  type ResponseStreamEvent,
  type ResponseTextDeltaEvent,
  type ResponseTextDoneEvent
} from '~/services/copilot/create-responses'

import { type AnthropicStreamEventData } from './anthropic-types'
import { THINKING_TEXT, translateResponsesResultToAnthropic } from './responses-translation'

const MAX_CONSECUTIVE_FUNCTION_CALL_WHITESPACE = 20

class FunctionCallArgumentsValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FunctionCallArgumentsValidationError'
  }
}

function updateWhitespaceRunState(
  previousCount: number,
  chunk: string
): { nextCount: number; exceeded: boolean } {
  let count = previousCount

  for (const char of chunk) {
    if (char === '\r' || char === '\n' || char === '\t') {
      count += 1
      if (count > MAX_CONSECUTIVE_FUNCTION_CALL_WHITESPACE) {
        return { nextCount: count, exceeded: true }
      }
      continue
    }
    if (char !== ' ') {
      count = 0
    }
  }

  return { nextCount: count, exceeded: false }
}

// =========================
// Stream State
// =========================

export interface ResponsesStreamState {
  messageStartSent: boolean
  messageCompleted: boolean
  nextContentBlockIndex: number
  blockIndexByKey: Map<string, number>
  openBlocks: Set<number>
  blockHasDelta: Set<number>
  functionCallStateByOutputIndex: Map<number, FunctionCallStreamState>
}

interface FunctionCallStreamState {
  blockIndex: number
  toolCallId: string
  name: string
  consecutiveWhitespaceCount: number
}

export function createResponsesStreamState(): ResponsesStreamState {
  return {
    messageStartSent: false,
    messageCompleted: false,
    nextContentBlockIndex: 0,
    blockIndexByKey: new Map(),
    openBlocks: new Set(),
    blockHasDelta: new Set(),
    functionCallStateByOutputIndex: new Map()
  }
}

// =========================
// Main Translator
// =========================

export function translateResponsesStreamEvent(
  rawEvent: ResponseStreamEvent,
  state: ResponsesStreamState
): AnthropicStreamEventData[] {
  switch (rawEvent.type) {
    case 'response.created':
      return handleResponseCreated(rawEvent, state)
    case 'response.output_item.added':
      return handleOutputItemAdded(rawEvent, state)
    case 'response.reasoning_summary_text.delta':
      return handleReasoningSummaryTextDelta(rawEvent, state)
    case 'response.output_text.delta':
      return handleOutputTextDelta(rawEvent, state)
    case 'response.reasoning_summary_text.done':
      return handleReasoningSummaryTextDone(rawEvent, state)
    case 'response.output_text.done':
      return handleOutputTextDone(rawEvent, state)
    case 'response.output_item.done':
      return handleOutputItemDone(rawEvent, state)
    case 'response.function_call_arguments.delta':
      return handleFunctionCallArgumentsDelta(rawEvent, state)
    case 'response.function_call_arguments.done':
      return handleFunctionCallArgumentsDone(rawEvent, state)
    case 'response.completed':
    case 'response.incomplete':
      return handleResponseCompleted(rawEvent, state)
    case 'response.failed':
      return handleResponseFailed(rawEvent, state)
    case 'error':
      return handleErrorEvent(rawEvent, state)
    default:
      return []
  }
}

// =========================
// Event Handlers
// =========================

function handleResponseCreated(
  rawEvent: ResponseCreatedEvent,
  state: ResponsesStreamState
): AnthropicStreamEventData[] {
  return messageStart(state, rawEvent.response)
}

function handleOutputItemAdded(
  rawEvent: ResponseOutputItemAddedEvent,
  state: ResponsesStreamState
): AnthropicStreamEventData[] {
  const events: AnthropicStreamEventData[] = []
  const functionCallDetails = extractFunctionCallDetails(rawEvent)
  if (!functionCallDetails) return events

  const { outputIndex, toolCallId, name, initialArguments } = functionCallDetails
  const blockIndex = openFunctionCallBlock(state, {
    outputIndex,
    toolCallId,
    name,
    events
  })

  if (initialArguments !== undefined && initialArguments.length > 0) {
    events.push({
      type: 'content_block_delta',
      index: blockIndex,
      delta: { type: 'input_json_delta', partial_json: initialArguments }
    })
    state.blockHasDelta.add(blockIndex)
  }

  return events
}

function handleOutputItemDone(
  rawEvent: ResponseOutputItemDoneEvent,
  state: ResponsesStreamState
): AnthropicStreamEventData[] {
  const events: AnthropicStreamEventData[] = []
  const item = rawEvent.item
  if (item.type !== 'reasoning') return events

  const outputIndex = rawEvent.output_index
  const blockIndex = openThinkingBlockIfNeeded(state, outputIndex, events)
  const signature = (item.encrypted_content ?? '') + '@' + item.id

  if (signature) {
    // Compatible with opencode: it filters out blocks where thinking text is empty
    if (!item.summary || item.summary.length === 0) {
      events.push({
        type: 'content_block_delta',
        index: blockIndex,
        delta: { type: 'thinking_delta', thinking: THINKING_TEXT }
      })
    }

    events.push({
      type: 'content_block_delta',
      index: blockIndex,
      delta: { type: 'signature_delta', signature }
    })
    state.blockHasDelta.add(blockIndex)
  }

  return events
}

function handleFunctionCallArgumentsDelta(
  rawEvent: ResponseFunctionCallArgumentsDeltaEvent,
  state: ResponsesStreamState
): AnthropicStreamEventData[] {
  const events: AnthropicStreamEventData[] = []
  const outputIndex = rawEvent.output_index
  const deltaText = rawEvent.delta

  if (!deltaText) return events

  const blockIndex = openFunctionCallBlock(state, { outputIndex, events })

  const functionCallState = state.functionCallStateByOutputIndex.get(outputIndex)
  if (!functionCallState) {
    return handleFunctionCallArgumentsValidationError(
      new FunctionCallArgumentsValidationError(
        'Received function call arguments delta without an open tool call block.'
      ),
      state,
      events
    )
  }

  // Fix: Copilot function call returning infinite line breaks until max_tokens
  const { nextCount, exceeded } = updateWhitespaceRunState(
    functionCallState.consecutiveWhitespaceCount,
    deltaText
  )
  if (exceeded) {
    return handleFunctionCallArgumentsValidationError(
      new FunctionCallArgumentsValidationError(
        'Received function call arguments delta containing more than 20 consecutive whitespace characters.'
      ),
      state,
      events
    )
  }
  functionCallState.consecutiveWhitespaceCount = nextCount

  events.push({
    type: 'content_block_delta',
    index: blockIndex,
    delta: { type: 'input_json_delta', partial_json: deltaText }
  })
  state.blockHasDelta.add(blockIndex)

  return events
}

function handleFunctionCallArgumentsDone(
  rawEvent: ResponseFunctionCallArgumentsDoneEvent,
  state: ResponsesStreamState
): AnthropicStreamEventData[] {
  const events: AnthropicStreamEventData[] = []
  const outputIndex = rawEvent.output_index
  const blockIndex = openFunctionCallBlock(state, { outputIndex, events })

  const finalArguments = typeof rawEvent.arguments === 'string' ? rawEvent.arguments : undefined

  if (!state.blockHasDelta.has(blockIndex) && finalArguments) {
    events.push({
      type: 'content_block_delta',
      index: blockIndex,
      delta: { type: 'input_json_delta', partial_json: finalArguments }
    })
    state.blockHasDelta.add(blockIndex)
  }

  state.functionCallStateByOutputIndex.delete(outputIndex)
  return events
}

function handleOutputTextDelta(
  rawEvent: ResponseTextDeltaEvent,
  state: ResponsesStreamState
): AnthropicStreamEventData[] {
  const events: AnthropicStreamEventData[] = []
  const { output_index: outputIndex, content_index: contentIndex, delta: deltaText } = rawEvent

  if (!deltaText) return events

  const blockIndex = openTextBlockIfNeeded(state, {
    outputIndex,
    contentIndex,
    events
  })

  events.push({
    type: 'content_block_delta',
    index: blockIndex,
    delta: { type: 'text_delta', text: deltaText }
  })
  state.blockHasDelta.add(blockIndex)

  return events
}

function handleReasoningSummaryTextDelta(
  rawEvent: ResponseReasoningSummaryTextDeltaEvent,
  state: ResponsesStreamState
): AnthropicStreamEventData[] {
  const { output_index: outputIndex, delta: deltaText } = rawEvent
  const events: AnthropicStreamEventData[] = []
  const blockIndex = openThinkingBlockIfNeeded(state, outputIndex, events)

  events.push({
    type: 'content_block_delta',
    index: blockIndex,
    delta: { type: 'thinking_delta', thinking: deltaText }
  })
  state.blockHasDelta.add(blockIndex)

  return events
}

function handleReasoningSummaryTextDone(
  rawEvent: ResponseReasoningSummaryTextDoneEvent,
  state: ResponsesStreamState
): AnthropicStreamEventData[] {
  const { output_index: outputIndex, text } = rawEvent
  const events: AnthropicStreamEventData[] = []
  const blockIndex = openThinkingBlockIfNeeded(state, outputIndex, events)

  if (text && !state.blockHasDelta.has(blockIndex)) {
    events.push({
      type: 'content_block_delta',
      index: blockIndex,
      delta: { type: 'thinking_delta', thinking: text }
    })
  }

  return events
}

function handleOutputTextDone(
  rawEvent: ResponseTextDoneEvent,
  state: ResponsesStreamState
): AnthropicStreamEventData[] {
  const events: AnthropicStreamEventData[] = []
  const { output_index: outputIndex, content_index: contentIndex, text } = rawEvent

  const blockIndex = openTextBlockIfNeeded(state, {
    outputIndex,
    contentIndex,
    events
  })

  if (text && !state.blockHasDelta.has(blockIndex)) {
    events.push({
      type: 'content_block_delta',
      index: blockIndex,
      delta: { type: 'text_delta', text }
    })
  }

  return events
}

function handleResponseCompleted(
  rawEvent: ResponseCompletedEvent | ResponseIncompleteEvent,
  state: ResponsesStreamState
): AnthropicStreamEventData[] {
  const response = rawEvent.response
  const events: AnthropicStreamEventData[] = []

  closeAllOpenBlocks(state, events)
  const anthropic = translateResponsesResultToAnthropic(response)
  events.push(
    {
      type: 'message_delta',
      delta: {
        stop_reason: anthropic.stop_reason,
        stop_sequence: anthropic.stop_sequence
      },
      usage: anthropic.usage
    },
    { type: 'message_stop' }
  )
  state.messageCompleted = true
  return events
}

function handleResponseFailed(
  rawEvent: ResponseFailedEvent,
  state: ResponsesStreamState
): AnthropicStreamEventData[] {
  const response = rawEvent.response
  const events: AnthropicStreamEventData[] = []
  closeAllOpenBlocks(state, events)

  const message = response.error?.message ?? 'The response failed due to an unknown error.'

  events.push(buildErrorEvent(message))
  state.messageCompleted = true
  return events
}

function handleErrorEvent(
  rawEvent: ResponseErrorEvent,
  state: ResponsesStreamState
): AnthropicStreamEventData[] {
  const message =
    typeof rawEvent.message === 'string'
      ? rawEvent.message
      : 'An unexpected error occurred during streaming.'

  state.messageCompleted = true
  return [buildErrorEvent(message)]
}

function handleFunctionCallArgumentsValidationError(
  _error: FunctionCallArgumentsValidationError,
  state: ResponsesStreamState,
  events: AnthropicStreamEventData[] = []
): AnthropicStreamEventData[] {
  const reason = _error.message

  closeAllOpenBlocks(state, events)
  state.messageCompleted = true
  events.push(buildErrorEvent(reason))

  return events
}

// =========================
// Block Management
// =========================

function messageStart(
  state: ResponsesStreamState,
  response: ResponsesResult
): AnthropicStreamEventData[] {
  state.messageStartSent = true
  const inputCachedTokens = response.usage?.input_tokens_details?.cached_tokens
  const inputTokens = (response.usage?.input_tokens ?? 0) - (inputCachedTokens ?? 0)
  return [
    {
      type: 'message_start',
      message: {
        id: response.id,
        type: 'message',
        role: 'assistant',
        content: [],
        model: response.model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: inputTokens,
          output_tokens: 0,
          cache_read_input_tokens: inputCachedTokens ?? 0
        }
      }
    }
  ]
}

function openTextBlockIfNeeded(
  state: ResponsesStreamState,
  params: {
    outputIndex: number
    contentIndex: number
    events: AnthropicStreamEventData[]
  }
): number {
  const { outputIndex, contentIndex, events } = params
  const key = getBlockKey(outputIndex, contentIndex)
  let blockIndex = state.blockIndexByKey.get(key)

  if (blockIndex === undefined) {
    blockIndex = state.nextContentBlockIndex
    state.nextContentBlockIndex += 1
    state.blockIndexByKey.set(key, blockIndex)
  }

  if (!state.openBlocks.has(blockIndex)) {
    closeOpenBlocks(state, events)
    events.push({
      type: 'content_block_start',
      index: blockIndex,
      content_block: { type: 'text', text: '' }
    })
    state.openBlocks.add(blockIndex)
  }

  return blockIndex
}

function openThinkingBlockIfNeeded(
  state: ResponsesStreamState,
  outputIndex: number,
  events: AnthropicStreamEventData[]
): number {
  // Thinking blocks may have multiple summary_index; combine into one block
  const summaryIndex = 0
  const key = getBlockKey(outputIndex, summaryIndex)
  let blockIndex = state.blockIndexByKey.get(key)

  if (blockIndex === undefined) {
    blockIndex = state.nextContentBlockIndex
    state.nextContentBlockIndex += 1
    state.blockIndexByKey.set(key, blockIndex)
  }

  if (!state.openBlocks.has(blockIndex)) {
    closeOpenBlocks(state, events)
    events.push({
      type: 'content_block_start',
      index: blockIndex,
      content_block: { type: 'thinking', thinking: '' }
    })
    state.openBlocks.add(blockIndex)
  }

  return blockIndex
}

function closeBlockIfOpen(
  state: ResponsesStreamState,
  blockIndex: number,
  events: AnthropicStreamEventData[]
): void {
  if (!state.openBlocks.has(blockIndex)) return

  events.push({ type: 'content_block_stop', index: blockIndex })
  state.openBlocks.delete(blockIndex)
  state.blockHasDelta.delete(blockIndex)
}

function closeOpenBlocks(state: ResponsesStreamState, events: AnthropicStreamEventData[]): void {
  for (const blockIndex of state.openBlocks) {
    closeBlockIfOpen(state, blockIndex, events)
  }
}

function closeAllOpenBlocks(state: ResponsesStreamState, events: AnthropicStreamEventData[]): void {
  closeOpenBlocks(state, events)
  state.functionCallStateByOutputIndex.clear()
}

export function buildErrorEvent(message: string): AnthropicStreamEventData {
  return {
    type: 'error',
    error: { type: 'api_error', message }
  }
}

function getBlockKey(outputIndex: number, contentIndex: number): string {
  return `${outputIndex}:${contentIndex}`
}

function openFunctionCallBlock(
  state: ResponsesStreamState,
  params: {
    outputIndex: number
    toolCallId?: string
    name?: string
    events: AnthropicStreamEventData[]
  }
): number {
  const { outputIndex, toolCallId, name, events } = params

  let functionCallState = state.functionCallStateByOutputIndex.get(outputIndex)

  if (!functionCallState) {
    const blockIndex = state.nextContentBlockIndex
    state.nextContentBlockIndex += 1

    const resolvedToolCallId = toolCallId ?? `tool_call_${blockIndex}`
    const resolvedName = name ?? 'function'

    functionCallState = {
      blockIndex,
      toolCallId: resolvedToolCallId,
      name: resolvedName,
      consecutiveWhitespaceCount: 0
    }

    state.functionCallStateByOutputIndex.set(outputIndex, functionCallState)
  }

  const { blockIndex } = functionCallState

  if (!state.openBlocks.has(blockIndex)) {
    closeOpenBlocks(state, events)
    events.push({
      type: 'content_block_start',
      index: blockIndex,
      content_block: {
        type: 'tool_use',
        id: functionCallState.toolCallId,
        name: functionCallState.name,
        input: {}
      }
    })
    state.openBlocks.add(blockIndex)
  }

  return blockIndex
}

// --- Helpers ---

interface FunctionCallDetails {
  outputIndex: number
  toolCallId: string
  name: string
  initialArguments?: string
}

function extractFunctionCallDetails(
  rawEvent: ResponseOutputItemAddedEvent
): FunctionCallDetails | undefined {
  const item = rawEvent.item
  if (item.type !== 'function_call') return undefined

  return {
    outputIndex: rawEvent.output_index,
    toolCallId: item.call_id,
    name: item.name,
    initialArguments: item.arguments
  }
}

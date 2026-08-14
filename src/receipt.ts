import { createHash } from 'node:crypto'
import { constants as osConstants } from 'node:os'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { Redactor, truncateText } from './redaction.js'
import type {
  ApprovalReceipt,
  GitSnapshot,
  ModelReceipt,
  Receipt,
  ReceiptOptions,
  ReceiptPayload,
  ToolArgumentSummary,
  ToolExecutionFacts,
  ToolObservation,
  ToolOutputSummary,
  ToolReceipt,
  TurnFailure,
  TurnStatus,
  UsageReceipt,
} from './types.js'

type TurnEndEvent = SessionEvent<'turn/end'>
const MAX_ARGUMENT_KEYS = 100
const SAFE_SIGNALS = new Set(Object.keys(osConstants.signals))
const SAFE_SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access'])
const SAFE_CONTENT_TYPES = new Set(['text', 'reasoning', 'image', 'tool-call', 'tool-result'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => canonicalize(item))
  if (!isRecord(value)) return value
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    const child = value[key]
    if (child !== undefined) result[key] = canonicalize(child)
  }
  return result
}

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function stringFact(record: Record<string, unknown>, key: string): string | null | undefined {
  const value = record[key]
  return typeof value === 'string' || value === null ? value : undefined
}

function numberFact(record: Record<string, unknown>, key: string): number | null | undefined {
  const value = record[key]
  if (value === null) return null
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function booleanFact(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key]
  return typeof value === 'boolean' ? value : undefined
}

function closedString(value: string, allowed: ReadonlySet<string>): string {
  return allowed.has(value) ? value : 'unknown'
}

function sanitizeExecutionFacts(input: ToolExecutionFacts | undefined): ToolExecutionFacts | undefined {
  if (input === undefined) return undefined
  const facts: ToolExecutionFacts = {}
  if (input.exitCode === null || typeof input.exitCode === 'number' && Number.isSafeInteger(input.exitCode)) {
    facts.exitCode = input.exitCode
  }
  if (input.signal === null || typeof input.signal === 'string') {
    facts.signal = input.signal === null ? null : closedString(input.signal, SAFE_SIGNALS)
  }
  if (typeof input.timedOut === 'boolean') facts.timedOut = input.timedOut
  if (typeof input.aborted === 'boolean') facts.aborted = input.aborted
  if (typeof input.timeoutMs === 'number' && Number.isSafeInteger(input.timeoutMs) && input.timeoutMs >= 0) {
    facts.timeoutMs = input.timeoutMs
  }
  if (typeof input.outputTruncated === 'boolean') facts.outputTruncated = input.outputTruncated
  if (typeof input.sandboxMode === 'string') facts.sandboxMode = closedString(input.sandboxMode, SAFE_SANDBOX_MODES)
  if (typeof input.sandboxDenied === 'boolean') facts.sandboxDenied = input.sandboxDenied
  if (typeof input.backgroundStarted === 'boolean') facts.backgroundStarted = input.backgroundStarted
  if (input.inferred === true) facts.inferred = true
  return Object.keys(facts).length === 0 ? undefined : facts
}

/** Extract only non-content execution facts; canonical tool values are otherwise discarded. */
export function extractExecutionFacts(value: unknown): ToolExecutionFacts | undefined {
  if (!isRecord(value)) return undefined
  const candidates = [
    value,
    isRecord(value.sessionStatus) ? value.sessionStatus : undefined,
    isRecord(value.status) ? value.status : undefined,
    isRecord(value.result) ? value.result : undefined,
  ].filter((candidate): candidate is Record<string, unknown> => candidate !== undefined)

  const facts: ToolExecutionFacts = {}
  for (const candidate of candidates) {
    const exitCode = numberFact(candidate, 'exitCode')
    if (facts.exitCode === undefined && exitCode !== undefined) facts.exitCode = exitCode
    const signal = stringFact(candidate, 'signal')
    if (facts.signal === undefined && signal !== undefined) {
      facts.signal = signal === null ? null : closedString(signal, SAFE_SIGNALS)
    }
    const timedOut = booleanFact(candidate, 'timedOut')
    if (facts.timedOut === undefined && timedOut !== undefined) facts.timedOut = timedOut
    const aborted = booleanFact(candidate, 'aborted')
    if (facts.aborted === undefined && aborted !== undefined) facts.aborted = aborted
    const timeoutMs = numberFact(candidate, 'timeoutMs')
    if (typeof timeoutMs === 'number') facts.timeoutMs ??= timeoutMs
  }

  const stdout = isRecord(value.stdout) ? value.stdout : undefined
  const stderr = isRecord(value.stderr) ? value.stderr : undefined
  const outputTruncated = stdout?.truncated === true || stderr?.truncated === true || value.truncated === true
  if (outputTruncated) facts.outputTruncated = true

  const sandbox = isRecord(value.sandbox) ? value.sandbox : undefined
  if (sandbox !== undefined) {
    if (typeof sandbox.mode === 'string') facts.sandboxMode = closedString(sandbox.mode, SAFE_SANDBOX_MODES)
    if (typeof sandbox.denied === 'boolean') facts.sandboxDenied = sandbox.denied
  }
  if (value.kind === 'background') facts.backgroundStarted = true

  return sanitizeExecutionFacts(facts)
}

export function observeToolResult(
  sessionId: string,
  callId: string,
  name: string,
  result: Readonly<ToolExecutionResult>,
  observedAt: number = Date.now(),
): ToolObservation {
  const execution = result.isError ? undefined : extractExecutionFacts(result.value)
  const error = result.isError && result.error.info !== undefined
    ? { name: result.error.info.name, code: result.error.info.code }
    : undefined
  return {
    sessionId,
    callId,
    name,
    observedAt,
    isError: result.isError,
    ...(execution === undefined ? {} : { execution }),
    ...(error === undefined ? {} : { error }),
  }
}

function isoTime(epochMs: number): string {
  return new Date(epochMs).toISOString()
}

function turnStatus(kind: string): TurnStatus {
  switch (kind) {
    case 'completed': return 'completed'
    case 'error': return 'failed'
    case 'aborted': return 'cancelled'
    case 'blocked': return 'blocked'
    case 'max-tokens': return 'max-tokens'
    case 'interrupted': return 'interrupted'
    default: return 'unknown'
  }
}

function buildTurnFailure(reason: unknown, redactor: Redactor): TurnFailure | undefined {
  if (!isRecord(reason) || reason.kind !== 'error' || !isRecord(reason.error)) return undefined
  const rawMessage = typeof reason.error.message === 'string' ? reason.error.message : 'Unknown turn failure'
  const message = truncateText(redactor.redactString(rawMessage), 1_024).text
  const code = typeof reason.error.code === 'string'
    ? truncateText(redactor.redactString(reason.error.code), 256).text
    : undefined
  return { message, ...(code === undefined ? {} : { code }) }
}

function pickStringField(
  object: Record<string, unknown>,
  key: string,
  redactor: Redactor,
  maxChars: number,
): { value?: string; truncated: boolean } {
  const value = object[key]
  if (typeof value !== 'string') return { truncated: false }
  const result = truncateText(redactor.redactString(value), maxChars)
  return { value: result.text, truncated: result.truncated }
}

function toolArgumentSummary(raw: unknown, redactor: Redactor, maxChars: number): ToolArgumentSummary {
  let parsed: unknown
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      return {
        keys: [],
        summarySha256: sha256('unparsed-tool-arguments-v1'),
        parseError: true,
      }
    }
  } else parsed = raw

  if (!isRecord(parsed)) {
    return {
      keys: [],
      summarySha256: sha256(canonicalStringify({ type: Array.isArray(parsed) ? 'array' : typeof parsed })),
    }
  }

  const rawKeys = Object.keys(parsed)
  const summarizedKeys = rawKeys.map(key => truncateText(redactor.redactString(key), 128))
  const keys = summarizedKeys
    .map(key => key.text)
    .sort()
    .slice(0, MAX_ARGUMENT_KEYS)
  const command = pickStringField(parsed, 'command', redactor, maxChars)
  const workdir = pickStringField(parsed, 'workdir', redactor, Math.min(maxChars, 2_048))
  const safeSummary = {
    keys,
    ...(command.value === undefined ? {} : { command: command.value }),
    ...(workdir.value === undefined ? {} : { workdir: workdir.value }),
  }
  const truncated = rawKeys.length > keys.length
    || summarizedKeys.some(key => key.truncated)
    || command.truncated
    || workdir.truncated
  return {
    ...safeSummary,
    summarySha256: sha256(canonicalStringify(safeSummary)),
    ...(truncated ? { truncated: true } : {}),
  }
}

function toolOutputSummary(
  content: readonly unknown[],
  redactor: Redactor,
  options: ReceiptOptions,
): ToolOutputSummary {
  const serialized = JSON.stringify(content)
  const contentTypes = [...new Set(content.map((block) => {
    return isRecord(block) && typeof block.type === 'string'
      ? closedString(block.type, SAFE_CONTENT_TYPES)
      : 'unknown'
  }))].sort()
  const summary: ToolOutputSummary = {
    bytes: Buffer.byteLength(serialized, 'utf8'),
    blocks: content.length,
    contentTypes,
  }
  if (!options.includeOutputPreview) return summary

  const text = content
    .filter((block): block is Record<string, unknown> => isRecord(block))
    .map((block) => typeof block.text === 'string' ? block.text : '')
    .filter(Boolean)
    .join('\n')
  if (text.length === 0) return summary
  const preview = truncateText(redactor.redactString(text), options.maxOutputPreviewChars)
  summary.preview = preview.text
  if (preview.truncated) summary.previewTruncated = true
  return summary
}

interface LogicalToolResult {
  callId: string
  endedAt: number
  isError: boolean
  content: readonly unknown[]
  error?: { name: string; code: string }
}

function resultEventFacts(event: SessionEvent<'tool/result'>): LogicalToolResult | undefined {
  const block = event.data.message.content[0]
  if (block?.type !== 'tool-result') return undefined
  return {
    callId: String(block.toolCallId),
    endedAt: event.time,
    isError: block.isError === true,
    content: block.content,
    ...(event.data.error === undefined ? {} : { error: event.data.error }),
  }
}

interface LogicalToolCall {
  callId: string
  parentCallId?: string
  name: string
  arguments: unknown
  startedAt: number
  transport: 'native' | 'code-dispatch'
}

function codeDispatchStart(event: SessionEvent): LogicalToolCall | undefined {
  const raw = event as unknown as { type: string; time: number; data?: unknown }
  if (raw.type !== 'tool/code-dispatch-start' || !isRecord(raw.data)) return undefined
  if (typeof raw.data.subCallId !== 'string' || typeof raw.data.name !== 'string') return undefined
  return {
    callId: raw.data.subCallId,
    ...(typeof raw.data.parentCallId === 'string' ? { parentCallId: raw.data.parentCallId } : {}),
    name: raw.data.name,
    arguments: raw.data.arguments,
    startedAt: raw.time,
    transport: 'code-dispatch',
  }
}

function codeDispatchResult(event: SessionEvent): LogicalToolResult | undefined {
  const raw = event as unknown as { type: string; time: number; data?: unknown }
  if (raw.type !== 'tool/code-dispatch' || !isRecord(raw.data)) return undefined
  if (typeof raw.data.subCallId !== 'string' || !Array.isArray(raw.data.content)) return undefined
  return {
    callId: raw.data.subCallId,
    endedAt: raw.time,
    isError: raw.data.isError === true,
    content: raw.data.content,
  }
}

function callRef(sessionId: string, callId: string): string {
  return `call-${sha256(`${sessionId}\0${callId}`).slice(0, 16)}`
}

function classifyToolStatus(
  hasResult: boolean,
  isError: boolean,
  execution: ToolExecutionFacts | undefined,
): ToolReceipt['status'] {
  if (!hasResult) return 'missing-result'
  if (isError) return 'failed'
  if (execution?.timedOut === true) return 'timed-out'
  if (execution?.aborted === true || execution?.signal !== undefined && execution.signal !== null) return 'aborted'
  if (typeof execution?.exitCode === 'number' && execution.exitCode !== 0) return 'nonzero-exit'
  if (execution?.backgroundStarted === true) return 'background-started'
  return 'succeeded'
}

/** Recover the official bash/pwsh terminal marker when live execution facts were missed. */
function inferShellExecution(name: string, result: LogicalToolResult | undefined): ToolExecutionFacts | undefined {
  if (result === undefined || result.isError || !['bash', 'pwsh'].includes(name.toLowerCase())) return undefined
  const lastText = [...result.content].reverse().find((block): block is Record<string, unknown> => {
    return isRecord(block) && block.type === 'text' && typeof block.text === 'string'
  })
  if (lastText === undefined || typeof lastText.text !== 'string') return { exitCode: 0, inferred: true }
  const tail = lastText.text.slice(-1_024)
  const signal = /\n\[killed by signal: ([^\]\n]+)\]$/.exec(tail)?.[1]
  const exitRaw = /\n\[exit code: (\d+)\]$/.exec(tail)?.[1]
  const timeoutRaw = /\n\[timed out after (\d+)ms\](?:\n|$)/.exec(tail)?.[1]
  return {
    ...(signal === undefined ? {} : { signal }),
    ...(signal !== undefined ? {} : { exitCode: exitRaw === undefined ? 0 : Number(exitRaw) }),
    ...(timeoutRaw === undefined ? {} : { timedOut: true, timeoutMs: Number(timeoutRaw) }),
    inferred: true,
  }
}

function toolReceipts(
  sessionId: string,
  events: readonly SessionEvent[],
  observations: ReadonlyMap<string, ToolObservation>,
  redactor: Redactor,
  options: ReceiptOptions,
): ToolReceipt[] {
  const results = new Map<string, LogicalToolResult>()
  const calls: LogicalToolCall[] = []
  for (const event of events) {
    if (event.type === 'tool/call') {
      calls.push({
        callId: String(event.data.callId),
        name: event.data.name,
        arguments: event.data.arguments,
        startedAt: event.time,
        transport: 'native',
      })
    } else if (event.type === 'tool/result') {
      const facts = resultEventFacts(event)
      if (facts !== undefined) results.set(facts.callId, facts)
    } else {
      const start = codeDispatchStart(event)
      if (start !== undefined) calls.push(start)
      const settled = codeDispatchResult(event)
      if (settled !== undefined) results.set(settled.callId, settled)
    }
  }

  const receipts: ToolReceipt[] = []
  for (const call of calls) {
    const result = results.get(call.callId)
    const observation = observations.get(call.callId)
    const execution = sanitizeExecutionFacts(observation?.execution ?? inferShellExecution(call.name, result))
    const failed = result?.isError === true || observation?.isError === true || result?.error !== undefined
    const endedAtMs = result?.endedAt ?? observation?.observedAt
    const eventError = result?.error
    const error = eventError === undefined && observation?.error === undefined
      ? undefined
      : {
          ...(eventError?.name === undefined && observation?.error?.name === undefined
            ? {}
            : { name: truncateText(redactor.redactString(eventError?.name ?? observation?.error?.name ?? ''), 256).text }),
          ...(eventError?.code === undefined && observation?.error?.code === undefined
            ? {}
            : { code: truncateText(redactor.redactString(eventError?.code ?? observation?.error?.code ?? ''), 256).text }),
        }

    receipts.push({
      callRef: callRef(sessionId, call.callId),
      ...(call.parentCallId === undefined ? {} : { parentCallRef: callRef(sessionId, call.parentCallId) }),
      name: truncateText(redactor.redactString(call.name), 256).text,
      transport: call.transport,
      status: classifyToolStatus(result !== undefined || observation !== undefined, failed, execution),
      startedAt: isoTime(call.startedAt),
      ...(endedAtMs === undefined ? {} : {
        endedAt: isoTime(endedAtMs),
        durationMs: Math.max(0, endedAtMs - call.startedAt),
        timingSource: result === undefined ? 'live-result-observation' : 'durable-events',
      }),
      arguments: toolArgumentSummary(call.arguments, redactor, options.maxCommandChars),
      ...(result === undefined ? {} : { output: toolOutputSummary(result.content, redactor, options) }),
      ...(execution === undefined ? {} : { execution }),
      ...(error === undefined || Object.keys(error).length === 0 ? {} : { error }),
    })
  }
  return receipts
}

function approvalReceipts(sessionId: string, events: readonly SessionEvent[], redactor: Redactor): ApprovalReceipt[] {
  const outcomes = new Set<string>(['allowed-once', 'rejected', 'cancelled', 'unavailable'])
  const approvals = new Map<string, ApprovalReceipt>()
  for (const rawEvent of events) {
    const event = rawEvent as unknown as { type: string; data?: unknown }
    if (!isRecord(event.data)) continue
    if (event.type === 'approval/asked' && typeof event.data.id === 'string') {
      approvals.set(event.data.id, {
        ref: `approval-${sha256(`${sessionId}\0${event.data.id}`).slice(0, 16)}`,
        ...(typeof event.data.toolName === 'string'
          ? { toolName: truncateText(redactor.redactString(event.data.toolName), 256).text }
          : {}),
        ...(typeof event.data.callId === 'string' ? { callRef: callRef(sessionId, event.data.callId) } : {}),
      })
    } else if (event.type === 'approval/decided' && typeof event.data.id === 'string') {
      const current = approvals.get(event.data.id) ?? { ref: `approval-${sha256(`${sessionId}\0${event.data.id}`).slice(0, 16)}` }
      if (typeof event.data.outcome === 'string') {
        current.outcome = outcomes.has(event.data.outcome)
          ? event.data.outcome as NonNullable<ApprovalReceipt['outcome']>
          : 'unknown'
      }
      approvals.set(event.data.id, current)
    }
  }
  return [...approvals.values()]
}

function stepKey(turn: number, step: number): string {
  return `${turn}:${step}`
}

function boundedModelText(value: string, redactor: Redactor): string {
  return truncateText(redactor.redactString(value), 256).text
}

/**
 * Successful requests use assistant-message provenance, which records the route
 * that actually answered. A request header is used only for a usage-only failed
 * step; merely selecting a route is not reported as a model call.
 */
function modelReceipts(turnEvents: readonly SessionEvent[], redactor: Redactor): ModelReceipt[] {
  const routesByStep = new Map<string, ModelReceipt>()
  const usageSteps = new Set<string>()
  const responseSteps = new Set<string>()
  const unique = new Map<string, ModelReceipt>()
  let activeStep: string | undefined

  const add = (receipt: ModelReceipt): void => {
    const key = `${receipt.provider}\0${receipt.model}`
    const current = unique.get(key)
    if (current === undefined || current.reasoningEffort === undefined && receipt.reasoningEffort !== undefined) {
      unique.set(key, receipt)
    }
  }

  for (const event of turnEvents) {
    if (event.type === 'step/start') {
      activeStep = stepKey(event.data.turn, event.data.step)
      continue
    }
    if (event.type === 'step/end') {
      activeStep = undefined
      continue
    }
    if (event.type === 'request/header' && activeStep !== undefined) {
      const config = event.data.header.config
      routesByStep.set(activeStep, {
        provider: boundedModelText(config.provider, redactor),
        model: boundedModelText(config.model, redactor),
        ...(config.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: boundedModelText(String(config.reasoningEffort), redactor) }),
      })
      continue
    }
    if (event.type === 'assistant/chunk' && event.data.chunk.type === 'usage') {
      usageSteps.add(stepKey(event.data.turn, event.data.step))
      continue
    }
    if (event.type === 'assistant/message') {
      const key = stepKey(event.data.turn, event.data.step)
      responseSteps.add(key)
      const source = event.data.message.source
      const configured = routesByStep.get(key)
      const provider = boundedModelText(source.provider, redactor)
      const model = boundedModelText(source.model, redactor)
      add({
        provider,
        model,
        ...(configured?.provider === provider && configured.model === model && configured.reasoningEffort !== undefined
          ? { reasoningEffort: configured.reasoningEffort }
          : {}),
      })
      continue
    }

    const raw = event as unknown as { type: string; data?: unknown }
    if (raw.type === 'compaction/summary' && isRecord(raw.data)
      && typeof raw.data.provider === 'string' && typeof raw.data.model === 'string') {
      add({
        provider: boundedModelText(raw.data.provider, redactor),
        model: boundedModelText(raw.data.model, redactor),
      })
    }
  }

  for (const key of usageSteps) {
    if (responseSteps.has(key)) continue
    const configured = routesByStep.get(key)
    if (configured !== undefined) add(configured)
  }
  return [...unique.values()]
}

function usageFromUnknown(value: unknown): UsageReceipt | undefined {
  if (!isRecord(value)) return undefined
  const required = (key: 'inputTokens' | 'outputTokens'): number | undefined => {
    const candidate = value[key]
    return typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0
      ? candidate
      : undefined
  }
  const optional = (key: 'cacheReadTokens' | 'cacheWriteTokens' | 'reasoningTokens'): number | undefined => {
    const candidate = value[key]
    return typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0
      ? candidate
      : undefined
  }
  const inputTokens = required('inputTokens')
  const outputTokens = required('outputTokens')
  if (inputTokens === undefined || outputTokens === undefined) return undefined
  const cacheReadTokens = optional('cacheReadTokens')
  const cacheWriteTokens = optional('cacheWriteTokens')
  const reasoningTokens = optional('reasoningTokens')
  return {
    inputTokens,
    outputTokens,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  }
}

/** Same last-wins fold as DSH token-meter, plus separately keyed compaction calls. */
function usageReceipt(events: readonly SessionEvent[]): UsageReceipt | undefined {
  const samples = new Map<string, UsageReceipt>()
  for (const event of events) {
    let key: string | undefined
    let usage: UsageReceipt | undefined
    if (event.type === 'assistant/chunk' && event.data.chunk.type === 'usage') {
      key = `step:${stepKey(event.data.turn, event.data.step)}`
      usage = usageFromUnknown(event.data.chunk.usage)
    } else if (event.type === 'assistant/message' && event.data.usage !== undefined) {
      key = `step:${stepKey(event.data.turn, event.data.step)}`
      usage = usageFromUnknown(event.data.usage)
    } else {
      const raw = event as unknown as { type: string; seq: number; data?: unknown }
      if (raw.type === 'compaction/summary' && isRecord(raw.data)) {
        key = `compaction:${raw.seq}`
        usage = usageFromUnknown(raw.data.usage)
      }
    }
    if (key !== undefined && usage !== undefined) samples.set(key, usage)
  }
  if (samples.size === 0) return undefined

  const total: UsageReceipt = { inputTokens: 0, outputTokens: 0 }
  let hasCacheRead = false
  let hasCacheWrite = false
  let hasReasoning = false
  for (const usage of samples.values()) {
    total.inputTokens += usage.inputTokens
    total.outputTokens += usage.outputTokens
    if (usage.cacheReadTokens !== undefined) {
      total.cacheReadTokens = (total.cacheReadTokens ?? 0) + usage.cacheReadTokens
      hasCacheRead = true
    }
    if (usage.cacheWriteTokens !== undefined) {
      total.cacheWriteTokens = (total.cacheWriteTokens ?? 0) + usage.cacheWriteTokens
      hasCacheWrite = true
    }
    if (usage.reasoningTokens !== undefined) {
      total.reasoningTokens = (total.reasoningTokens ?? 0) + usage.reasoningTokens
      hasReasoning = true
    }
  }
  if (!hasCacheRead) delete total.cacheReadTokens
  if (!hasCacheWrite) delete total.cacheWriteTokens
  if (!hasReasoning) delete total.reasoningTokens
  return total
}

export interface BuildReceiptInput {
  header: SessionHeader
  events: readonly SessionEvent[]
  endEvent: TurnEndEvent
  observations: ReadonlyMap<string, ToolObservation>
  git: GitSnapshot
  options: ReceiptOptions
  generatedAt?: number
}

export function buildReceipt(input: BuildReceiptInput): Receipt {
  const sessionId = String(input.header.id)
  const redactor = new Redactor(undefined, input.header.cwd)
  const endSeq = input.endEvent.seq
  const turnNumber = input.endEvent.data.turn
  const eventsThroughEnd = input.events.filter(event => event.seq <= endSeq)
  const startEvent = [...eventsThroughEnd].reverse().find((event): event is SessionEvent<'turn/start'> => {
    return event.type === 'turn/start' && event.data.turn === turnNumber
  })
  const startSeq = startEvent?.seq ?? endSeq
  const startedAtMs = startEvent?.time ?? input.endEvent.time
  const turnEvents = eventsThroughEnd.filter(event => event.seq >= startSeq)
  const reason = input.endEvent.data.reason as unknown
  const reasonKind = isRecord(reason) && typeof reason.kind === 'string' ? reason.kind : 'unknown'
  const safeReasonKind = truncateText(redactor.redactString(reasonKind), 128).text
  const status = turnStatus(reasonKind)
  const tools = toolReceipts(sessionId, turnEvents, input.observations, redactor, input.options)
  const git = redactor.redactValue(input.git) as GitSnapshot
  const missingResults = tools.filter(tool => tool.status === 'missing-result').length
  const observedResults = tools.length - missingResults
  const limitations = [
    'Natural-language claims are not classified or verified by this MVP.',
    'Complete prompts, assistant messages, environment variables, and tool outputs are intentionally omitted.',
    'Provider cost is omitted because the core session event does not provide authoritative pricing.',
    'Tool elapsed times are observation/commit intervals, not precise tool-body execution durations.',
    'Only live turn/end events observed while the plugin is loaded produce receipts; historical crash turns are not backfilled.',
  ]
  if (git.available) {
    limitations.push('Git evidence is the whole workspace state at turn end and is not causal attribution to this turn.')
    limitations.push('Git probes are non-transactional and can race concurrent workspace changes.')
  } else {
    limitations.push(`Git evidence is unavailable (${git.reason}).`)
  }
  if (missingResults > 0) limitations.push(`${missingResults} tool call(s) had no matching result at the terminal boundary.`)
  if (tools.some(tool => tool.execution === undefined)) {
    limitations.push('Some tools lack live execution metadata; their durable session result still determines success or failure.')
  }
  if (tools.some(tool => tool.execution?.inferred === true)) {
    limitations.push('Some shell exit facts were inferred from DSH durable output markers because live execution metadata was unavailable.')
  }
  if (turnEvents.some(event => (event as unknown as { type: string }).type === 'compaction/summary')) {
    limitations.push('Usage totals include any model-backed compaction summary committed inside this turn.')
  }
  if (status === 'unknown') limitations.push(`Unrecognized terminal reason ${JSON.stringify(safeReasonKind)} was not interpreted as success.`)

  const generatedAt = input.generatedAt ?? Date.now()
  const failure = buildTurnFailure(reason, redactor)
  const usage = usageReceipt(turnEvents)
  const payload: ReceiptPayload = {
    schemaVersion: 1,
    producer: {
      name: 'dsh-receipt',
      version: '0.1.0',
      testedHarnessVersion: '0.1.0-rc.6',
    },
    receiptId: `receipt-${sha256(`${sessionId}\0${turnNumber}`).slice(0, 24)}`,
    generatedAt: isoTime(generatedAt),
    session: {
      ref: `session-${sha256(sessionId).slice(0, 16)}`,
      ...(input.header.cwd === undefined ? {} : { cwd: redactor.redactString(input.header.cwd) }),
      ...(input.header.parentSession === undefined
        ? {}
        : { parentRef: `session-${sha256(String(input.header.parentSession)).slice(0, 16)}` }),
      ...(input.header.origin === undefined ? {} : { origin: input.header.origin }),
      ...(input.header.delegationDepth === undefined ? {} : { delegationDepth: input.header.delegationDepth }),
      ...(input.header.agentPreset === undefined
        ? {}
        : { agentPreset: truncateText(redactor.redactString(input.header.agentPreset), 256).text }),
    },
    turn: {
      number: turnNumber,
      status,
      reason: safeReasonKind,
      startedAt: isoTime(startedAtMs),
      endedAt: isoTime(input.endEvent.time),
      durationMs: Math.max(0, input.endEvent.time - startedAtMs),
      startSeq,
      endSeq,
      capture: reasonKind === 'interrupted' ? 'recovered' : 'live',
      ...(reasonKind !== 'aborted' || !isRecord(reason) || !isRecord(reason.reason) || typeof reason.reason.kind !== 'string'
        ? {}
        : { cancelCause: truncateText(redactor.redactString(reason.reason.kind), 128).text }),
      ...(failure === undefined ? {} : { failure }),
    },
    models: modelReceipts(turnEvents, redactor),
    ...(usage === undefined ? {} : { usage }),
    tools,
    approvals: approvalReceipts(sessionId, turnEvents, redactor),
    git,
    verification: {
      sources: ['session/event', 'tools/result', 'git'],
      observedToolCalls: tools.length,
      observedToolResults: observedResults,
      failedTools: tools.filter(tool => ['failed', 'nonzero-exit', 'timed-out', 'aborted'].includes(tool.status)).length,
      claimVerification: {
        status: 'not-evaluated',
        reason: 'The MVP records execution evidence but does not infer claims from assistant prose.',
      },
      limitations,
    },
    redaction: { total: 0, byKind: {} },
  }
  payload.redaction = redactor.report()
  return {
    ...payload,
    integrity: {
      algorithm: 'sha256',
      canonicalization: 'sorted-json-v1',
      digest: sha256(canonicalStringify(payload)),
    },
  }
}

export function verifyReceipt(receipt: Receipt): boolean {
  try {
    if (!isRecord(receipt) || !isRecord(receipt.integrity)) return false
    const { integrity, ...payload } = receipt
    return integrity.algorithm === 'sha256'
      && integrity.canonicalization === 'sorted-json-v1'
      && typeof integrity.digest === 'string'
      && integrity.digest === sha256(canonicalStringify(payload))
  } catch {
    return false
  }
}

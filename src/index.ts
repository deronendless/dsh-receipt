import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { collectGitSnapshot } from './git.js'
import { Redactor, truncateText } from './redaction.js'
import { buildReceipt, observeToolResult, sha256 } from './receipt.js'
import type { ReceiptOptions, ToolObservation } from './types.js'
import { writeReceipt } from './writer.js'

export * from './types.js'
export { canonicalStringify, extractExecutionFacts, sha256, verifyReceipt } from './receipt.js'
export { collectGitSnapshot, isSensitivePath, parseNumstat, parsePorcelainStatus } from './git.js'
export { isSensitiveKey, Redactor, truncateText } from './redaction.js'
export { renderReceiptMarkdown, safeSessionDirectory, writeReceipt } from './writer.js'

export const name = 'receipt'
export const inject = ['sessions', 'tools']

const DEFAULTS = {
  includeOutputPreview: false,
  maxOutputPreviewChars: 512,
  maxCommandChars: 4_096,
  maxChangedFiles: 200,
  maxHashedFileBytes: 0,
  gitTimeoutMs: 3_000,
} as const

export interface Config {
  /** Absolute local destination. Defaults at apply time to `$DSH_HOME/receipts` or `~/.dsh/receipts`. */
  outputDir?: string
  /** Opt in to a bounded, redacted text preview. Complete tool output is never stored. */
  includeOutputPreview?: boolean
  maxOutputPreviewChars?: number
  maxCommandChars?: number
  maxChangedFiles?: number
  /** Opt in to tracked-file content hashing with a per-file byte cap. Zero disables all content reads. */
  maxHashedFileBytes?: number
  gitTimeoutMs?: number
}

export const Config: z<Config> = z.object({
  outputDir: z.string().min(1),
  includeOutputPreview: z.boolean().default(DEFAULTS.includeOutputPreview),
  maxOutputPreviewChars: z.number().step(1).min(1).default(DEFAULTS.maxOutputPreviewChars),
  maxCommandChars: z.number().step(1).min(1).default(DEFAULTS.maxCommandChars),
  maxChangedFiles: z.number().step(1).min(1).default(DEFAULTS.maxChangedFiles),
  maxHashedFileBytes: z.number().step(1).min(0).default(DEFAULTS.maxHashedFileBytes),
  gitTimeoutMs: z.number().step(1).min(1).default(DEFAULTS.gitTimeoutMs),
})

function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

function defaultOutputDir(): string {
  const configuredHome = process.env.DSH_HOME
  const dshHome = configuredHome === undefined || configuredHome.trim().length === 0
    ? join(homedir(), '.dsh')
    : expandHome(configuredHome)
  return join(resolve(dshHome), 'receipts')
}

export function resolveOptions(config: Config = {}): ReceiptOptions {
  let outputDir = defaultOutputDir()
  if (config.outputDir !== undefined) {
    const expanded = expandHome(config.outputDir)
    if (!isAbsolute(expanded)) throw new Error('dsh-receipt: outputDir must be an absolute path (or begin with ~/).')
    outputDir = resolve(expanded)
  }
  return {
    outputDir,
    includeOutputPreview: config.includeOutputPreview ?? DEFAULTS.includeOutputPreview,
    maxOutputPreviewChars: config.maxOutputPreviewChars ?? DEFAULTS.maxOutputPreviewChars,
    maxCommandChars: config.maxCommandChars ?? DEFAULTS.maxCommandChars,
    maxChangedFiles: config.maxChangedFiles ?? DEFAULTS.maxChangedFiles,
    maxHashedFileBytes: config.maxHashedFileBytes ?? DEFAULTS.maxHashedFileBytes,
    gitTimeoutMs: config.gitTimeoutMs ?? DEFAULTS.gitTimeoutMs,
  }
}

function turnCallIds(events: readonly SessionEvent[], endEvent: SessionEvent<'turn/end'>): Set<string> {
  const start = [...events].reverse().find((event): event is SessionEvent<'turn/start'> => {
    return event.seq <= endEvent.seq && event.type === 'turn/start' && event.data.turn === endEvent.data.turn
  })
  const startSeq = start?.seq ?? endEvent.seq
  const result = new Set<string>()
  for (const event of events) {
    if (event.seq < startSeq || event.seq > endEvent.seq) continue
    if (event.type === 'tool/call') result.add(String(event.data.callId))
    const raw = event as unknown as { type: string; data?: unknown }
    const subCallId = raw.data !== null && typeof raw.data === 'object'
      ? (raw.data as Record<string, unknown>).subCallId
      : undefined
    if ((raw.type === 'tool/code-dispatch-start' || raw.type === 'tool/code-dispatch')
      && typeof subCallId === 'string') {
      result.add(subCallId)
    }
  }
  return result
}

function turnEventSlice(events: readonly SessionEvent[], endEvent: SessionEvent<'turn/end'>): SessionEvent[] {
  let endIndex = events.length - 1
  while (endIndex >= 0 && (events[endIndex]?.seq ?? Number.POSITIVE_INFINITY) > endEvent.seq) endIndex -= 1
  let startIndex = endIndex
  while (startIndex >= 0) {
    const candidate = events[startIndex]
    if (candidate?.type === 'turn/start' && candidate.data.turn === endEvent.data.turn) break
    startIndex -= 1
  }
  if (endIndex < 0 || startIndex < 0) return [endEvent]
  return events.slice(startIndex, endIndex + 1)
}

function safeLogError(error: unknown, workspace?: string): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : typeof error === 'string' ? error : 'unknown error'
  return truncateText(new Redactor(undefined, workspace).redactString(raw), 512).text
}

export function apply(ctx: Context, config: Config = {}): void {
  const options = resolveOptions(config)
  const observations = new Map<string, Map<string, ToolObservation>>()
  const tails = new Map<string, Promise<void>>()
  const pending = new Set<Promise<void>>()

  // Registered first so reverse-order unload closes event ingress before this final drain.
  ctx.effect(() => async () => {
    await Promise.all([...pending])
  }, 'dsh-receipt: drain pending writes')

  ctx.on('tools/result', (exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>) => {
    try {
      const sessionId = exec.agent?.session.id
      if (sessionId === undefined) return
      const key = String(sessionId)
      const sessionObservations = observations.get(key) ?? new Map<string, ToolObservation>()
      sessionObservations.set(String(exec.callId), observeToolResult(
        key,
        String(exec.callId),
        exec.name,
        result,
      ))
      observations.set(key, sessionObservations)
    } catch (error) {
      ctx.logger.warn(`dsh-receipt: tools/result observation failed: ${safeLogError(error)}`)
    }
  })

  ctx.on('session/event', (session, event) => {
    try {
      if (event.type !== 'turn/end') return
      const sessionId = String(session.id)
      // Retain only this turn in the async job; prior conversation content never
      // needs to cross the receipt boundary.
      const events = turnEventSlice(session.events, event)
      const ids = turnCallIds(events, event)
      const observed = new Map<string, ToolObservation>()
      const sessionObservations = observations.get(sessionId)
      for (const id of ids) {
        const observation = sessionObservations?.get(id)
        if (observation !== undefined) observed.set(id, observation)
        sessionObservations?.delete(id)
      }
      if (sessionObservations?.size === 0) observations.delete(sessionId)

      // Start the read-only snapshot at the event boundary, before a queued follow-up turn can drift it.
      const git = collectGitSnapshot(session.header.cwd, {
        maxChangedFiles: options.maxChangedFiles,
        maxHashedFileBytes: options.maxHashedFileBytes,
        timeoutMs: options.gitTimeoutMs,
      })
      const previous = tails.get(sessionId) ?? Promise.resolve()
      const task = previous
        .then(async () => {
          const receipt = buildReceipt({
            header: session.header,
            events,
            endEvent: event,
            observations: observed,
            git: await git,
            options,
            generatedAt: event.time,
          })
          await writeReceipt(receipt, options.outputDir, sessionId)
        })
        .catch((error: unknown) => {
          const sessionRef = sha256(sessionId).slice(0, 12)
          ctx.logger.warn(`dsh-receipt: receipt write failed for session ${sessionRef}: ${safeLogError(error, session.header.cwd)}`)
        })
      tails.set(sessionId, task)
      pending.add(task)
      void task.finally(() => {
        pending.delete(task)
        if (tails.get(sessionId) === task) tails.delete(sessionId)
      })
    } catch (error) {
      ctx.logger.warn(`dsh-receipt: turn/end observation failed: ${safeLogError(error, session.header.cwd)}`)
    }
  })

  ctx.on('session/flush', (session) => tails.get(String(session.id)))

  ctx.on('session/disposed', (session) => {
    observations.delete(String(session.id))
  })

}

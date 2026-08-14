import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { buildReceipt, extractExecutionFacts, verifyReceipt } from '../src/receipt.js'
import type { GitSnapshot, ReceiptOptions, ToolObservation } from '../src/types.js'

const options: ReceiptOptions = {
  outputDir: '/unused',
  includeOutputPreview: false,
  maxOutputPreviewChars: 128,
  maxCommandChars: 4_096,
  maxChangedFiles: 200,
  maxHashedFileBytes: 1_024,
  gitTimeoutMs: 3_000,
}

const header: SessionHeader = {
  version: 0,
  id: SessionId('session-private-id'),
  createdAt: 900,
  cwd: '/Users/alice/project',
}

const git: GitSnapshot = {
  available: true,
  scope: 'workspace-at-turn-end',
  repositoryRoot: '/Users/alice/project',
  branch: 'main',
  head: 'a'.repeat(40),
  dirty: true,
  changedFiles: [{
    path: 'src/index.ts',
    status: ' M',
    additions: 2,
    deletions: 1,
    worktreeSha256: 'b'.repeat(64),
    hashState: 'hashed',
  }],
  changedFilesTruncated: false,
  diff: { files: 1, additions: 2, deletions: 1, binaryFiles: 0 },
  warnings: [],
}

function event<T extends SessionEvent['type']>(
  type: T,
  seq: number,
  time: number,
  data: unknown,
): SessionEvent<T> {
  return { type, seq, time, data } as unknown as SessionEvent<T>
}

function fixture(commandSecret = 'sk-abcdefghijklmnopqrstuvwxyz123456'): {
  events: SessionEvent[]
  endEvent: SessionEvent<'turn/end'>
  observations: Map<string, ToolObservation>
} {
  const events: SessionEvent[] = [
    event('turn/start', 0, 1_000, { turn: 1 }),
    event('step/start', 1, 1_010, { turn: 1, step: 1 }),
    event('request/header', 2, 1_020, {
      header: { config: { provider: 'deepseek', model: 'deepseek-chat' } },
      reason: 'initial',
    }),
    event('tool/call', 3, 1_030, {
      turn: 1,
      step: 1,
      callId: 'call-raw-id',
      name: 'bash',
      arguments: JSON.stringify({
        command: `curl -H "Authorization: Bearer ${commandSecret}" /Users/alice/project`,
        description: 'Call a service with password=hunter2',
        workdir: '/Users/alice/project',
        apiKey: commandSecret,
      }),
    }),
    event('tool/result', 4, 1_080, {
      turn: 1,
      step: 1,
      message: {
        id: 'message-1',
        role: 'user',
        source: { kind: 'tool', callId: 'call-raw-id', toolName: 'bash' },
        content: [{
          type: 'tool-result',
          toolCallId: 'call-raw-id',
          content: [{ type: 'text', text: 'output has sk-output-secret-abcdefghijklmnop' }],
        }],
      },
    }),
    event('assistant/message', 5, 1_090, {
      turn: 1,
      step: 1,
      message: {
        id: 'message-2',
        role: 'assistant',
        source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
        content: [],
      },
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 },
    }),
    event('step/end', 8, 1_110, { turn: 1, step: 1 }),
  ]
  events.push({
    type: 'approval/asked',
    seq: 6,
    time: 1_095,
    data: { id: 'approval-raw-id', toolName: 'bash', callId: 'call-raw-id', reason: 'password=approval-secret' },
  } as unknown as SessionEvent)
  events.push({
    type: 'approval/decided',
    seq: 7,
    time: 1_100,
    data: { id: 'approval-raw-id', outcome: 'allowed-once' },
  } as unknown as SessionEvent)
  events.sort((left, right) => left.seq - right.seq)
  const endEvent = event('turn/end', 9, 1_200, { turn: 1, reason: { kind: 'completed' } })
  events.push(endEvent)
  const observations = new Map<string, ToolObservation>([['call-raw-id', {
    sessionId: 'session-private-id',
    callId: 'call-raw-id',
    name: 'bash',
    observedAt: 1_075,
    isError: false,
    execution: { exitCode: 0, timedOut: false, outputTruncated: false },
  }]])
  return { events, endEvent, observations }
}

describe('buildReceipt', () => {
  it('reduces a completed turn to redacted, correlated, integrity-protected evidence', () => {
    const input = fixture()
    const receipt = buildReceipt({
      header,
      ...input,
      git,
      options,
      generatedAt: 1_200,
    })
    const serialized = JSON.stringify(receipt)

    expect(receipt.turn).toMatchObject({
      number: 1,
      status: 'completed',
      reason: 'completed',
      capture: 'live',
      durationMs: 200,
      startSeq: 0,
      endSeq: 9,
    })
    expect(receipt.session).toEqual({ ref: expect.stringMatching(/^session-[a-f0-9]{16}$/), cwd: '$WORKSPACE' })
    expect(receipt.models).toEqual([{ provider: 'deepseek', model: 'deepseek-chat' }])
    expect(receipt.usage).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 })
    expect(receipt.tools).toHaveLength(1)
    expect(receipt.tools[0]).toMatchObject({
      callRef: expect.stringMatching(/^call-[a-f0-9]{16}$/),
      name: 'bash',
      transport: 'native',
      status: 'succeeded',
      durationMs: 50,
      execution: { exitCode: 0 },
      output: { blocks: 1, contentTypes: ['text'] },
    })
    expect(receipt.tools[0]?.arguments.command).toContain('[REDACTED:authorization]')
    expect(receipt.tools[0]?.arguments.command).toContain('$WORKSPACE')
    expect(receipt.approvals).toEqual([expect.objectContaining({
      ref: expect.stringMatching(/^approval-[a-f0-9]{16}$/),
      outcome: 'allowed-once',
    })])
    expect(receipt.git.available && receipt.git.repositoryRoot).toBe('$WORKSPACE')
    expect(receipt.redaction.total).toBeGreaterThan(0)
    expect(verifyReceipt(receipt)).toBe(true)

    expect(serialized).not.toContain('session-private-id')
    expect(serialized).not.toContain('call-raw-id')
    expect(serialized).not.toContain('approval-raw-id')
    expect(serialized).not.toContain('hunter2')
    expect(serialized).not.toContain('approval-secret')
    expect(serialized).not.toContain('sk-output-secret')
    expect(serialized).not.toContain('/Users/alice')
  })

  it('hashes only the already-redacted argument summary', () => {
    const first = fixture('sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    const second = fixture('sk-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
    const receiptA = buildReceipt({ header, ...first, git, options, generatedAt: 1_200 })
    const receiptB = buildReceipt({ header, ...second, git, options, generatedAt: 1_200 })
    expect(receiptA.tools[0]?.arguments.summarySha256).toBe(receiptB.tools[0]?.arguments.summarySha256)
  })

  it('replaces streaming usage with the final sample and retains usage-only failed steps', () => {
    const start = event('turn/start', 0, 1_000, { turn: 1 })
    const end = event('turn/end', 10, 1_200, {
      turn: 1,
      reason: { kind: 'error', error: { code: 'REQUEST_FAILED', message: 'failed' } },
    })
    const events: SessionEvent[] = [
      start,
      event('step/start', 1, 1_010, { turn: 1, step: 1 }),
      event('request/header', 2, 1_020, {
        header: { config: { provider: 'selected-route', model: 'selected-model', reasoningEffort: 'high' } },
        reason: 'initial',
      }),
      event('assistant/chunk', 3, 1_030, {
        turn: 1,
        step: 1,
        chunk: { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } },
      }),
      event('assistant/message', 4, 1_040, {
        turn: 1,
        step: 1,
        message: {
          id: 'actual-message',
          role: 'assistant',
          source: { kind: 'model', provider: 'actual-route', model: 'actual-model' },
          content: [],
        },
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 },
      }),
      event('step/end', 5, 1_050, { turn: 1, step: 1 }),
      event('step/start', 6, 1_060, { turn: 1, step: 2 }),
      event('request/header', 7, 1_070, {
        header: { config: { provider: 'failed-route', model: 'failed-model' } },
        reason: 'change',
      }),
      event('assistant/chunk', 8, 1_080, {
        turn: 1,
        step: 2,
        chunk: { type: 'usage', usage: { inputTokens: 4, outputTokens: 1, reasoningTokens: 1 } },
      }),
      event('step/end', 9, 1_090, { turn: 1, step: 2 }),
      end,
    ]
    const receipt = buildReceipt({
      header,
      events,
      endEvent: end,
      observations: new Map(),
      git: { available: false, reason: 'not-a-git-repository' },
      options,
      generatedAt: 1_200,
    })

    expect(receipt.usage).toEqual({
      inputTokens: 14,
      outputTokens: 6,
      cacheReadTokens: 3,
      reasoningTokens: 1,
    })
    expect(receipt.models).toEqual([
      { provider: 'actual-route', model: 'actual-model' },
      { provider: 'failed-route', model: 'failed-model' },
    ])
    expect(receipt.models).not.toContainEqual({ provider: 'selected-route', model: 'selected-model' })
  })

  it('does not report an old configured route for a turn with no model call', () => {
    const priorHeader = event('request/header', 0, 100, {
      header: { config: { provider: 'stale-provider', model: 'stale-model' } },
      reason: 'initial',
    })
    const start = event('turn/start', 1, 200, { turn: 1 })
    const end = event('turn/end', 2, 300, { turn: 1, reason: { kind: 'blocked' } })
    const receipt = buildReceipt({
      header,
      events: [priorHeader, start, end],
      endEvent: end,
      observations: new Map(),
      git: { available: false, reason: 'not-a-git-repository' },
      options,
      generatedAt: 300,
    })
    expect(receipt.models).toEqual([])
    expect(receipt.usage).toBeUndefined()
  })

  it('uses one-way references for parent sessions', () => {
    const input = fixture()
    const childHeader: SessionHeader = {
      ...header,
      id: SessionId('child-private-id'),
      parentSession: SessionId('parent-private-id'),
    }
    const receipt = buildReceipt({ header: childHeader, ...input, git, options, generatedAt: 1_200 })
    expect(receipt.session.parentRef).toMatch(/^session-[a-f0-9]{16}$/)
    expect(JSON.stringify(receipt)).not.toContain('parent-private-id')
  })

  it.each([
    [{ kind: 'error', error: { code: 'MODEL_ERROR', message: 'failed with password=secret' } }, 'failed'],
    [{ kind: 'aborted', reason: { kind: 'user' } }, 'cancelled'],
    [{ kind: 'blocked' }, 'blocked'],
    [{ kind: 'max-tokens' }, 'max-tokens'],
    [{ kind: 'interrupted' }, 'interrupted'],
    [{ kind: 'future-terminal-state' }, 'unknown'],
  ] as const)('maps terminal reason %o to %s without guessing success', (reason, status) => {
    const start = event('turn/start', 0, 100, { turn: 1 })
    const end = event('turn/end', 1, 200, { turn: 1, reason })
    const receipt = buildReceipt({
      header,
      events: [start, end],
      endEvent: end,
      observations: new Map(),
      git: { available: false, reason: 'not-a-git-repository' },
      options,
      generatedAt: 200,
    })
    expect(receipt.turn.status).toBe(status)
    expect(verifyReceipt(receipt)).toBe(true)
    expect(JSON.stringify(receipt)).not.toContain('password=secret')
    if (status === 'interrupted') expect(receipt.turn.capture).toBe('recovered')
  })

  it('does not persist oversized output when previews are disabled', () => {
    const input = fixture()
    const result = input.events.find(item => item.type === 'tool/result') as SessionEvent<'tool/result'>
    const block = result.data.message.content[0]
    if (block?.type !== 'tool-result') throw new Error('invalid fixture')
    const canary = 'DO-NOT-PERSIST-' + 'x'.repeat(200_000)
    ;(block.content as { type: 'text'; text: string }[])[0] = { type: 'text', text: canary }
    const receipt = buildReceipt({ header, ...input, git, options, generatedAt: 1_200 })
    const serialized = JSON.stringify(receipt)
    expect(receipt.tools[0]?.output?.bytes).toBeGreaterThan(200_000)
    expect(receipt.tools[0]?.output?.preview).toBeUndefined()
    expect(serialized).not.toContain('DO-NOT-PERSIST')
    expect(serialized.length).toBeLessThan(20_000)
  })

  it('detects payload tampering', () => {
    const input = fixture()
    const receipt = buildReceipt({ header, ...input, git, options, generatedAt: 1_200 })
    receipt.turn.durationMs += 1
    expect(verifyReceipt(receipt)).toBe(false)
  })

  it('returns false instead of throwing for a malformed artifact', () => {
    expect(verifyReceipt({ integrity: null } as unknown as ReturnType<typeof buildReceipt>)).toBe(false)
  })
})

describe('tool status classification', () => {
  it.each([
    [{ exitCode: 7 }, 'nonzero-exit'],
    [{ exitCode: 0, timedOut: true }, 'timed-out'],
    [{ exitCode: null, signal: 'SIGTERM' }, 'aborted'],
    [{ backgroundStarted: true }, 'background-started'],
  ] as const)('classifies structured execution facts %o as %s', (execution, expected) => {
    const input = fixture()
    input.observations.get('call-raw-id')!.execution = { ...execution }
    const receipt = buildReceipt({ header, ...input, git, options, generatedAt: 1_200 })
    expect(receipt.tools[0]?.status).toBe(expected)
  })

  it('infers a shell non-zero exit from the official durable marker when live facts are absent', () => {
    const input = fixture()
    input.observations.clear()
    const result = input.events.find(item => item.type === 'tool/result') as SessionEvent<'tool/result'>
    const block = result.data.message.content[0]
    if (block?.type !== 'tool-result') throw new Error('invalid fixture')
    ;(block.content as { type: 'text'; text: string }[])[0] = { type: 'text', text: 'failed\n[exit code: 7]' }
    const receipt = buildReceipt({ header, ...input, git, options, generatedAt: 1_200 })
    expect(receipt.tools[0]).toMatchObject({
      status: 'nonzero-exit',
      execution: { exitCode: 7, inferred: true },
    })
  })

  it('maps extension-controlled execution strings and content types to closed vocabulary', () => {
    expect(extractExecutionFacts({
      signal: 'SIG_SECRET_CANARY',
      sandbox: { mode: 'sandbox-secret-canary', denied: true },
    })).toEqual({ signal: 'unknown', sandboxMode: 'unknown', sandboxDenied: true })

    const input = fixture()
    input.observations.get('call-raw-id')!.execution = {
      signal: 'SIG_OBSERVATION_SECRET',
      sandboxMode: 'sandbox-observation-secret',
    }
    const result = input.events.find(item => item.type === 'tool/result') as SessionEvent<'tool/result'>
    const block = result.data.message.content[0]
    if (block?.type !== 'tool-result') throw new Error('invalid fixture')
    ;(block.content as unknown[])[0] = { type: 'content-type-secret-canary', text: 'omitted' }
    const receipt = buildReceipt({ header, ...input, git, options, generatedAt: 1_200 })
    const serialized = JSON.stringify(receipt)
    expect(receipt.tools[0]).toMatchObject({
      execution: { signal: 'unknown', sandboxMode: 'unknown' },
      output: { contentTypes: ['unknown'] },
    })
    expect(serialized).not.toContain('SECRET_CANARY')
    expect(serialized).not.toContain('observation-secret')
    expect(serialized).not.toContain('content-type-secret')
  })
})

describe('Code Mode evidence', () => {
  it('includes nested code dispatches without hiding them behind run_code', () => {
    const input = fixture()
    input.events.splice(-1, 0,
      {
        type: 'tool/code-dispatch-start',
        seq: 8.1,
        time: 1_120,
        data: {
          rootCallId: 'call-raw-id',
          parentCallId: 'call-raw-id',
          subCallId: 'call-raw-id:code:0',
          name: 'read_file',
          arguments: { path: 'README.md' },
        },
      } as unknown as SessionEvent,
      {
        type: 'tool/code-dispatch',
        seq: 8.2,
        time: 1_140,
        data: {
          rootCallId: 'call-raw-id',
          parentCallId: 'call-raw-id',
          subCallId: 'call-raw-id:code:0',
          name: 'read_file',
          arguments: { path: 'README.md' },
          isError: false,
          content: [{ type: 'text', text: 'omitted output' }],
        },
      } as unknown as SessionEvent,
    )
    const receipt = buildReceipt({ header, ...input, git, options, generatedAt: 1_200 })
    expect(receipt.tools).toHaveLength(2)
    expect(receipt.tools[1]).toMatchObject({
      name: 'read_file',
      transport: 'code-dispatch',
      status: 'succeeded',
      durationMs: 20,
      parentCallRef: receipt.tools[0]?.callRef,
    })
  })
})

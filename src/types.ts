export type RedactionKind =
  | 'credential'
  | 'private-key'
  | 'known-token'
  | 'authorization'
  | 'home-path'
  | 'workspace-path'

export interface RedactionReport {
  total: number
  byKind: Partial<Record<RedactionKind, number>>
}

export type TurnStatus =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'blocked'
  | 'max-tokens'
  | 'interrupted'
  | 'unknown'

export interface TurnFailure {
  code?: string
  message: string
}

export interface TurnReceipt {
  number: number
  status: TurnStatus
  reason: string
  startedAt: string
  endedAt: string
  durationMs: number
  startSeq: number
  endSeq: number
  capture: 'live' | 'recovered'
  cancelCause?: string
  failure?: TurnFailure
}

export interface SessionReceipt {
  ref: string
  cwd?: string
  parentRef?: string
  origin?: string
  delegationDepth?: number
  agentPreset?: string
}

export interface ModelReceipt {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface UsageReceipt {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

export interface ToolArgumentSummary {
  keys: string[]
  summarySha256: string
  command?: string
  workdir?: string
  truncated?: boolean
  parseError?: boolean
}

export interface ToolOutputSummary {
  bytes: number
  blocks: number
  contentTypes: string[]
  preview?: string
  previewTruncated?: boolean
}

export interface ToolExecutionFacts {
  exitCode?: number | null
  signal?: string | null
  timedOut?: boolean
  aborted?: boolean
  timeoutMs?: number
  outputTruncated?: boolean
  sandboxMode?: string
  sandboxDenied?: boolean
  backgroundStarted?: boolean
  /** True only when facts were reconstructed from DSH's durable shell marker. */
  inferred?: boolean
}

export interface ToolErrorReceipt {
  name?: string
  code?: string
}

export interface ToolReceipt {
  callRef: string
  parentCallRef?: string
  name: string
  transport: 'native' | 'code-dispatch'
  status:
    | 'succeeded'
    | 'failed'
    | 'nonzero-exit'
    | 'timed-out'
    | 'aborted'
    | 'background-started'
    | 'missing-result'
  startedAt: string
  endedAt?: string
  durationMs?: number
  timingSource?: 'durable-events' | 'live-result-observation'
  arguments: ToolArgumentSummary
  output?: ToolOutputSummary
  execution?: ToolExecutionFacts
  error?: ToolErrorReceipt
}

export interface ApprovalReceipt {
  ref: string
  toolName?: string
  callRef?: string
  outcome?: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' | 'unknown'
}

export interface GitChangedFile {
  path: string
  previousPath?: string
  status: string
  additions?: number
  deletions?: number
  binary?: boolean
  worktreeSha256?: string
  hashState?:
    | 'hashed'
    | 'disabled'
    | 'deleted'
    | 'too-large'
    | 'non-regular'
    | 'unreadable'
    | 'untracked-not-read'
    | 'sensitive-path-not-read'
}

export interface GitDiffSummary {
  files: number
  additions: number
  deletions: number
  binaryFiles: number
}

export interface GitSnapshotAvailable {
  available: true
  scope: 'workspace-at-turn-end'
  repositoryRoot: string
  branch: string | null
  head: string | null
  dirty: boolean
  changedFiles: GitChangedFile[]
  changedFilesTruncated: boolean
  diff: GitDiffSummary
  warnings: string[]
}

export interface GitSnapshotUnavailable {
  available: false
  reason: 'no-session-cwd' | 'not-a-git-repository' | 'git-unavailable' | 'git-timeout' | 'git-error'
  message?: string
}

export type GitSnapshot = GitSnapshotAvailable | GitSnapshotUnavailable

export interface VerificationReceipt {
  sources: string[]
  observedToolCalls: number
  observedToolResults: number
  failedTools: number
  claimVerification: {
    status: 'not-evaluated'
    reason: string
  }
  limitations: string[]
}

export interface ProducerReceipt {
  name: 'dsh-receipt'
  version: string
  testedHarnessVersion: string
}

export interface ReceiptPayload {
  schemaVersion: 1
  producer: ProducerReceipt
  receiptId: string
  generatedAt: string
  session: SessionReceipt
  turn: TurnReceipt
  models: ModelReceipt[]
  usage?: UsageReceipt
  tools: ToolReceipt[]
  approvals: ApprovalReceipt[]
  git: GitSnapshot
  verification: VerificationReceipt
  redaction: RedactionReport
}

export interface ReceiptIntegrity {
  algorithm: 'sha256'
  canonicalization: 'sorted-json-v1'
  digest: string
}

export interface Receipt extends ReceiptPayload {
  integrity: ReceiptIntegrity
}

/** Safe facts extracted from a live `tools/result`; complete values never enter a receipt. */
export interface ToolObservation {
  sessionId: string
  callId: string
  name: string
  observedAt: number
  isError: boolean
  execution?: ToolExecutionFacts
  error?: ToolErrorReceipt
}

export interface ReceiptOptions {
  outputDir: string
  includeOutputPreview: boolean
  maxOutputPreviewChars: number
  maxCommandChars: number
  maxChangedFiles: number
  maxHashedFileBytes: number
  gitTimeoutMs: number
}

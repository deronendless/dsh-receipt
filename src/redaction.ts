import { homedir } from 'node:os'
import type { RedactionKind, RedactionReport } from './types.js'

const PRIVATE_KEY_PATTERN = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/g
const AUTHORIZATION_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi
const KNOWN_TOKEN_PATTERNS: RegExp[] = [
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
]

const CREDENTIAL_ASSIGNMENT_PATTERN = /(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|authorization|cookie|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*)(?!\[REDACTED:)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&}\]]+)/gi
const ENV_CREDENTIAL_PATTERN = /(\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*=)(?!\[REDACTED:)[^\s;&]+/g
const UNIX_USER_PATH_PATTERN = /(\/(?:Users|home)\/)[^/\s"']+/g
const WINDOWS_USER_PATH_PATTERN = /\b([A-Z]:\\Users\\)[^\\\s"']+/gi
const URL_CREDENTIAL_PATTERN = /\b(https?:\/\/)[^\s\/:@]+:[^\s\/@]+@/gi

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normalizedSensitiveKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function isSensitiveKey(key: string): boolean {
  const normalized = normalizedSensitiveKey(key)
  return normalized.includes('password')
    || normalized.includes('passwd')
    || normalized.includes('secret')
    // Credential token fields conventionally end in singular `token`.
    // Plural accounting fields such as inputTokens/outputTokens are not secrets.
    || normalized.endsWith('token')
    || normalized.includes('apikey')
    || normalized.includes('authorization')
    || normalized.includes('cookie')
    || normalized.includes('privatekey')
    || normalized.includes('credential')
}

export interface TruncatedText {
  text: string
  truncated: boolean
}

export function truncateText(value: string, maxChars: number): TruncatedText {
  if (value.length <= maxChars) return { text: value, truncated: false }
  return { text: `${value.slice(0, Math.max(0, maxChars - 1))}…`, truncated: true }
}

/** Stateful so one receipt can report exactly what was removed before persistence. */
export class Redactor {
  private readonly counts = new Map<RedactionKind, number>()
  private readonly homePattern: RegExp | undefined
  private readonly workspacePattern: RegExp | undefined

  constructor(home: string = homedir(), workspace?: string) {
    const normalizedHome = home.trim().replace(/[\\/]+$/, '')
    const normalizedWorkspace = workspace?.trim().replace(/[\\/]+$/, '') ?? ''
    this.homePattern = normalizedHome.length === 0
      ? undefined
      : new RegExp(`${escapeRegExp(normalizedHome)}(?=$|[\\\\/])`, process.platform === 'win32' ? 'gi' : 'g')
    this.workspacePattern = normalizedWorkspace.length === 0
      ? undefined
      : new RegExp(`${escapeRegExp(normalizedWorkspace)}(?=$|[\\\\/])`, process.platform === 'win32' ? 'gi' : 'g')
  }

  private count(kind: RedactionKind): void {
    this.counts.set(kind, (this.counts.get(kind) ?? 0) + 1)
  }

  private replace(
    value: string,
    pattern: RegExp,
    kind: RedactionKind,
    replacement: string | ((match: string, ...groups: string[]) => string),
  ): string {
    return value.replace(pattern, (match: string, ...args: unknown[]) => {
      this.count(kind)
      if (typeof replacement === 'string') return replacement
      const groups = args.slice(0, Math.max(0, args.length - 2)).map(String)
      return replacement(match, ...groups)
    })
  }

  redactString(input: string): string {
    let value = this.replace(input, PRIVATE_KEY_PATTERN, 'private-key', '[REDACTED:private-key]')
    value = this.replace(value, URL_CREDENTIAL_PATTERN, 'credential', (_match, scheme) => `${scheme}[REDACTED:credential]@`)
    value = this.replace(value, AUTHORIZATION_PATTERN, 'authorization', (_match, scheme) => `${scheme} [REDACTED:authorization]`)
    for (const pattern of KNOWN_TOKEN_PATTERNS) {
      value = this.replace(value, pattern, 'known-token', '[REDACTED:known-token]')
    }
    value = this.replace(value, CREDENTIAL_ASSIGNMENT_PATTERN, 'credential', (_match, prefix) => `${prefix}[REDACTED:credential]`)
    value = this.replace(value, ENV_CREDENTIAL_PATTERN, 'credential', (_match, prefix) => `${prefix}[REDACTED:credential]`)
    if (this.workspacePattern !== undefined) {
      value = this.replace(value, this.workspacePattern, 'workspace-path', '$WORKSPACE')
    }
    if (this.homePattern !== undefined) {
      value = this.replace(value, this.homePattern, 'home-path', '~')
    }
    value = this.replace(value, UNIX_USER_PATH_PATTERN, 'home-path', (_match, prefix) => `${prefix}<user>`)
    value = this.replace(value, WINDOWS_USER_PATH_PATTERN, 'home-path', (_match, prefix) => `${prefix}<user>`)
    return value
  }

  redactValue(value: unknown): unknown {
    if (typeof value === 'string') return this.redactString(value)
    if (Array.isArray(value)) return value.map(item => this.redactValue(item))
    if (value === null || typeof value !== 'object') return value

    const result: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(key)) {
        this.count('credential')
        result[key] = '[REDACTED:credential]'
      } else {
        result[key] = this.redactValue(child)
      }
    }
    return result
  }

  report(): RedactionReport {
    const byKind: RedactionReport['byKind'] = {}
    let total = 0
    for (const [kind, count] of this.counts) {
      byKind[kind] = count
      total += count
    }
    return { total, byKind }
  }
}

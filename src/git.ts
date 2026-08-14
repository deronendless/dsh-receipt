import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { isAbsolute, relative, resolve } from 'node:path'
import type { GitChangedFile, GitDiffSummary, GitSnapshot } from './types.js'

const GIT_MAX_BUFFER = 16 * 1024 * 1024
const GIT_CONFIG_PREFIX = ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false'] as const

interface GitCommandResult {
  stdout: string
  stderr: string
}

interface GitCommandFailure extends Error {
  code?: string | number
  killed?: boolean
  signal?: NodeJS.Signals
  stdout?: string
  stderr?: string
}

function runGit(cwd: string, args: string[], timeoutMs: number): Promise<GitCommandResult> {
  return new Promise((resolvePromise, reject) => {
    const env = { ...process.env }
    for (const key of [
      'GIT_DIR',
      'GIT_WORK_TREE',
      'GIT_COMMON_DIR',
      'GIT_INDEX_FILE',
      'GIT_OBJECT_DIRECTORY',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES',
      'GIT_EXTERNAL_DIFF',
      'GIT_DIFF_OPTS',
      'GIT_CONFIG_COUNT',
      'GIT_CONFIG_PARAMETERS',
    ]) delete env[key]
    for (const key of Object.keys(env)) {
      if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) delete env[key]
    }
    execFile(
      'git',
      [...GIT_CONFIG_PREFIX, ...args],
      {
        cwd,
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: GIT_MAX_BUFFER,
        windowsHide: true,
        env: {
          ...env,
          GIT_OPTIONAL_LOCKS: '0',
          GIT_NO_LAZY_FETCH: '1',
          GIT_TERMINAL_PROMPT: '0',
          GIT_PAGER: 'cat',
          PAGER: 'cat',
        },
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          const failure = error as GitCommandFailure
          failure.stdout = stdout
          failure.stderr = stderr
          reject(failure)
          return
        }
        resolvePromise({ stdout, stderr })
      },
    )
  })
}

function isTimeout(error: unknown): boolean {
  const failure = error as GitCommandFailure
  return failure?.killed === true || failure?.signal === 'SIGTERM'
}

function isGitMissing(error: unknown): boolean {
  return (error as GitCommandFailure)?.code === 'ENOENT'
}

function failureMessage(error: unknown): string {
  const failure = error as GitCommandFailure
  if (failure?.signal !== undefined) return `git terminated by signal ${failure.signal}`
  if (failure?.code !== undefined) return `git exited with code ${String(failure.code)}`
  return 'git command failed'
}

function isNotGitRepository(error: unknown): boolean {
  const stderr = (error as GitCommandFailure)?.stderr
  return typeof stderr === 'string' && /not a git repository/i.test(stderr)
}

interface ParsedStatus {
  path: string
  previousPath?: string
  status: string
}

/** Parse `git status --porcelain=v1 -z`; paths stay byte-for-byte decoded by Node as UTF-8. */
export function parsePorcelainStatus(output: string): ParsedStatus[] {
  const records = output.split('\0')
  const result: ParsedStatus[] = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (record === undefined || record.length === 0) continue

    if (record.startsWith('?? ') || record.startsWith('!! ')) {
      result.push({ status: record.slice(0, 2), path: record.slice(3) })
      continue
    }
    if (record.length < 4) continue

    const status = record.slice(0, 2)
    const path = record.slice(3)
    if (/[RC]/.test(status)) {
      const previousPath = records[index + 1]
      if (previousPath !== undefined && previousPath.length > 0) {
        result.push({ status, path, previousPath })
        index += 1
        continue
      }
    }
    result.push({ status, path })
  }
  return result
}

interface DiffStat {
  additions?: number
  deletions?: number
  binary: boolean
}

interface ParsedNumstat {
  byPath: Map<string, DiffStat>
  summary: GitDiffSummary
}

/** `--no-renames` keeps every numstat record in the simple three-field form. */
export function parseNumstat(output: string): ParsedNumstat {
  const byPath = new Map<string, DiffStat>()
  const summary: GitDiffSummary = { files: 0, additions: 0, deletions: 0, binaryFiles: 0 }
  for (const record of output.split('\0')) {
    if (record.length === 0) continue
    const firstTab = record.indexOf('\t')
    const secondTab = firstTab < 0 ? -1 : record.indexOf('\t', firstTab + 1)
    if (firstTab < 0 || secondTab < 0) continue

    const additionsRaw = record.slice(0, firstTab)
    const deletionsRaw = record.slice(firstTab + 1, secondTab)
    const path = record.slice(secondTab + 1)
    const binary = additionsRaw === '-' || deletionsRaw === '-'
    const additions = binary ? undefined : Number.parseInt(additionsRaw, 10)
    const deletions = binary ? undefined : Number.parseInt(deletionsRaw, 10)
    const stat: DiffStat = {
      binary,
      ...(additions === undefined || Number.isNaN(additions) ? {} : { additions }),
      ...(deletions === undefined || Number.isNaN(deletions) ? {} : { deletions }),
    }
    byPath.set(path, stat)
    summary.files += 1
    if (binary) summary.binaryFiles += 1
    else {
      summary.additions += stat.additions ?? 0
      summary.deletions += stat.deletions ?? 0
    }
  }
  return { byPath, summary }
}

async function sha256Handle(handle: Awaited<ReturnType<typeof open>>): Promise<string> {
  const digest = createHash('sha256')
  await new Promise<void>((resolvePromise, reject) => {
    const stream = handle.createReadStream({ autoClose: false })
    stream.on('data', chunk => digest.update(chunk))
    stream.once('error', reject)
    stream.once('end', resolvePromise)
  })
  return digest.digest('hex')
}

async function attachFileHash(
  root: string,
  file: GitChangedFile,
  maxHashedFileBytes: number,
): Promise<void> {
  if (isSensitivePath(file.path)) {
    file.hashState = 'sensitive-path-not-read'
    return
  }
  if (file.status === '??') {
    file.hashState = 'untracked-not-read'
    return
  }
  if (maxHashedFileBytes === 0) {
    file.hashState = 'disabled'
    return
  }
  const absolutePath = resolve(root, file.path)
  const relativePath = relative(root, absolutePath)
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    file.hashState = 'unreadable'
    return
  }

  try {
    const before = await lstat(absolutePath)
    if (!before.isFile()) {
      file.hashState = 'non-regular'
      return
    }
    if (before.size > maxHashedFileBytes) {
      file.hashState = 'too-large'
      return
    }
    const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW
    const handle = await open(absolutePath, constants.O_RDONLY | noFollow)
    try {
      const opened = await handle.stat()
      // The identity check closes the lstat/open swap window, including on platforms
      // where O_NOFOLLOW is unavailable. The digest is read from this fixed handle.
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
        file.hashState = 'non-regular'
        return
      }
      if (opened.size > maxHashedFileBytes) {
        file.hashState = 'too-large'
        return
      }
      file.worktreeSha256 = await sha256Handle(handle)
      file.hashState = 'hashed'
    } finally {
      await handle.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') file.hashState = 'deleted'
    else file.hashState = 'unreadable'
  }
}

/** Fail closed: these files are never opened, even merely to compute a digest. */
export function isSensitivePath(path: string): boolean {
  const segments = path.replace(/\\/g, '/').toLowerCase().split('/')
  const basename = segments.at(-1) ?? ''
  if (segments.some(segment => ['.ssh', '.aws', '.azure', '.gnupg', '.kube', '.docker', 'gcloud'].includes(segment))) return true
  if (basename === '.env' || basename === '.envrc' || basename.startsWith('.env.') || basename.startsWith('.env-')) return true
  if (['.npmrc', '.pypirc', '.netrc', '.git-credentials', '.terraformrc'].includes(basename)) return true
  if (/^id_(?:rsa|dsa|ecdsa|ed25519)$/.test(basename)) return true
  if (/\.(?:pem|key|p12|pfx|jks|keystore)$/.test(basename)) return true
  return segments.some(segment => {
    const normalized = segment.replace(/[^a-z0-9]/g, '')
    return normalized.includes('credential')
      || normalized.includes('privatekey')
      || normalized.includes('password')
      || normalized.includes('passwd')
      || normalized.includes('secret')
      || normalized.includes('token')
      || normalized.includes('apikey')
      || normalized.includes('accesskey')
      || normalized.includes('cookie')
      || ['auth', 'oauth'].some(word => segment.split(/[^a-z0-9]+/).includes(word))
  })
}

async function hashFilesBounded(
  root: string,
  files: GitChangedFile[],
  maxHashedFileBytes: number,
): Promise<void> {
  let cursor = 0
  const workerCount = Math.min(8, files.length)
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (cursor < files.length) {
      const index = cursor
      cursor += 1
      const file = files[index]
      if (file !== undefined) await attachFileHash(root, file, maxHashedFileBytes)
    }
  }))
}

async function optionalGit(cwd: string, args: string[], timeoutMs: number): Promise<string | null> {
  try {
    const result = await runGit(cwd, args, timeoutMs)
    const value = result.stdout.trim()
    return value.length === 0 ? null : value
  } catch {
    return null
  }
}

export interface CollectGitOptions {
  maxChangedFiles: number
  maxHashedFileBytes: number
  timeoutMs: number
}

/** Fixed, read-only Git probes. A receipt still succeeds when Git is absent or the cwd is not a repository. */
export async function collectGitSnapshot(cwd: string | undefined, options: CollectGitOptions): Promise<GitSnapshot> {
  if (cwd === undefined) return { available: false, reason: 'no-session-cwd' }

  let repositoryRoot: string
  try {
    repositoryRoot = (await runGit(cwd, ['rev-parse', '--show-toplevel'], options.timeoutMs)).stdout.trim()
  } catch (error) {
    if (isGitMissing(error)) return { available: false, reason: 'git-unavailable' }
    if (isTimeout(error)) return { available: false, reason: 'git-timeout' }
    if (isNotGitRepository(error)) return { available: false, reason: 'not-a-git-repository' }
    return { available: false, reason: 'git-error', message: failureMessage(error) }
  }

  try {
    const [statusResult, branch, head] = await Promise.all([
      runGit(repositoryRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'], options.timeoutMs),
      optionalGit(repositoryRoot, ['branch', '--show-current'], options.timeoutMs),
      optionalGit(repositoryRoot, ['rev-parse', '--verify', 'HEAD'], options.timeoutMs),
    ])
    const parsedStatus = parsePorcelainStatus(statusResult.stdout)
    const selectedStatus = parsedStatus.slice(0, options.maxChangedFiles)
    const warnings: string[] = []

    let parsedDiff: ParsedNumstat = {
      byPath: new Map(),
      summary: { files: 0, additions: 0, deletions: 0, binaryFiles: 0 },
    }
    try {
      if (head !== null) {
        const diff = await runGit(repositoryRoot, ['diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--numstat', '-z', '--no-renames', 'HEAD', '--'], options.timeoutMs)
        parsedDiff = parseNumstat(diff.stdout)
      } else {
        const [unstaged, staged] = await Promise.all([
          runGit(repositoryRoot, ['diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--numstat', '-z', '--no-renames', '--'], options.timeoutMs),
          runGit(repositoryRoot, ['diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--cached', '--numstat', '-z', '--no-renames', '--'], options.timeoutMs),
        ])
        const first = parseNumstat(unstaged.stdout)
        const second = parseNumstat(staged.stdout)
        parsedDiff = {
          byPath: new Map([...first.byPath, ...second.byPath]),
          summary: {
            files: first.summary.files + second.summary.files,
            additions: first.summary.additions + second.summary.additions,
            deletions: first.summary.deletions + second.summary.deletions,
            binaryFiles: first.summary.binaryFiles + second.summary.binaryFiles,
          },
        }
      }
    } catch (error) {
      warnings.push(`diff summary unavailable: ${failureMessage(error)}`)
    }

    const changedFiles: GitChangedFile[] = selectedStatus.map((entry) => {
      const stat = parsedDiff.byPath.get(entry.path)
      return {
        path: entry.path,
        status: entry.status,
        ...(entry.previousPath === undefined ? {} : { previousPath: entry.previousPath }),
        ...(stat?.additions === undefined ? {} : { additions: stat.additions }),
        ...(stat?.deletions === undefined ? {} : { deletions: stat.deletions }),
        ...(stat?.binary === true ? { binary: true } : {}),
      }
    })
    await hashFilesBounded(repositoryRoot, changedFiles, options.maxHashedFileBytes)

    return {
      available: true,
      scope: 'workspace-at-turn-end',
      repositoryRoot,
      branch,
      head,
      dirty: parsedStatus.length > 0,
      changedFiles,
      changedFilesTruncated: parsedStatus.length > selectedStatus.length,
      diff: parsedDiff.summary,
      warnings,
    }
  } catch (error) {
    if (isTimeout(error)) return { available: false, reason: 'git-timeout' }
    return { available: false, reason: 'git-error', message: failureMessage(error) }
  }
}

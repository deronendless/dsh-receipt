import { execFile } from 'node:child_process'
import { access, chmod, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectGitSnapshot, isSensitivePath, parseNumstat, parsePorcelainStatus } from '../src/git.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

function git(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', args, { cwd }, (error) => error === null ? resolvePromise() : reject(error))
  })
}

async function repository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-receipt-git-'))
  temporaryDirectories.push(directory)
  await git(directory, ['init', '--quiet'])
  await git(directory, ['config', 'user.name', 'Receipt Test'])
  await git(directory, ['config', 'user.email', 'receipt@example.invalid'])
  await writeFile(join(directory, 'tracked.txt'), 'before\n', 'utf8')
  await git(directory, ['add', 'tracked.txt'])
  await git(directory, ['commit', '--quiet', '-m', 'initial'])
  return directory
}

describe('Git parsers', () => {
  it('parses NUL-delimited status including untracked and rename records', () => {
    expect(parsePorcelainStatus(' M tracked file\0?? new file\0R  renamed\0old name\0')).toEqual([
      { status: ' M', path: 'tracked file' },
      { status: '??', path: 'new file' },
      { status: 'R ', path: 'renamed', previousPath: 'old name' },
    ])
  })

  it('parses text and binary numstat records', () => {
    const parsed = parseNumstat('3\t2\ttracked.txt\0-\t-\timage.bin\0')
    expect(parsed.summary).toEqual({ files: 2, additions: 3, deletions: 2, binaryFiles: 1 })
    expect(parsed.byPath.get('tracked.txt')).toEqual({ additions: 3, deletions: 2, binary: false })
    expect(parsed.byPath.get('image.bin')).toEqual({ binary: true })
  })
})

describe('collectGitSnapshot', () => {
  it('captures tracked state but never opens untracked or sensitive-looking files for hashing', async () => {
    const directory = await repository()
    await writeFile(join(directory, 'tracked.txt'), 'after\n', 'utf8')
    await writeFile(join(directory, 'untracked.txt'), 'ordinary but untracked\n', 'utf8')
    await writeFile(join(directory, '.env'), 'API_KEY=must-not-be-read\n', 'utf8')

    const snapshot = await collectGitSnapshot(directory, {
      maxChangedFiles: 20,
      maxHashedFileBytes: 1_024 * 1_024,
      timeoutMs: 3_000,
    })

    expect(snapshot.available).toBe(true)
    if (!snapshot.available) return
    expect(snapshot.dirty).toBe(true)
    expect(snapshot.head).toMatch(/^[a-f0-9]{40}$/)
    expect(snapshot.diff.files).toBe(1)

    const tracked = snapshot.changedFiles.find(file => file.path === 'tracked.txt')
    const untracked = snapshot.changedFiles.find(file => file.path === 'untracked.txt')
    const environment = snapshot.changedFiles.find(file => file.path === '.env')
    expect(tracked?.hashState).toBe('hashed')
    expect(tracked?.worktreeSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(untracked).toMatchObject({ status: '??', hashState: 'untracked-not-read' })
    expect(environment).toMatchObject({ status: '??', hashState: 'sensitive-path-not-read' })
    expect(await readFile(join(directory, '.env'), 'utf8')).toContain('must-not-be-read')
  })

  it('reports a non-repository without failing receipt generation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-receipt-plain-'))
    temporaryDirectories.push(directory)
    await expect(collectGitSnapshot(directory, {
      maxChangedFiles: 20,
      maxHashedFileBytes: 1_024,
      timeoutMs: 3_000,
    })).resolves.toMatchObject({ available: false, reason: 'not-a-git-repository' })
  })

  it('keeps tracked file-content reads disabled when the byte cap is zero', async () => {
    const directory = await repository()
    await writeFile(join(directory, 'tracked.txt'), 'after\n', 'utf8')
    const snapshot = await collectGitSnapshot(directory, {
      maxChangedFiles: 20,
      maxHashedFileBytes: 0,
      timeoutMs: 3_000,
    })
    expect(snapshot.available).toBe(true)
    if (!snapshot.available) return
    expect(snapshot.changedFiles.find(file => file.path === 'tracked.txt')).toMatchObject({
      hashState: 'disabled',
    })
  })

  it.runIf(process.platform !== 'win32')('never follows a changed symbolic link for hashing', async () => {
    const directory = await repository()
    const link = join(directory, 'tracked-link')
    await symlink('tracked.txt', link)
    await git(directory, ['add', 'tracked-link'])
    await git(directory, ['commit', '--quiet', '-m', 'add link'])
    await unlink(link)
    await symlink('/etc/hosts', link)

    const snapshot = await collectGitSnapshot(directory, {
      maxChangedFiles: 20,
      maxHashedFileBytes: 1_024 * 1_024,
      timeoutMs: 3_000,
    })
    expect(snapshot.available).toBe(true)
    if (!snapshot.available) return
    expect(snapshot.changedFiles.find(file => file.path === 'tracked-link')).toMatchObject({
      hashState: 'non-regular',
    })
  })

  it.runIf(process.platform !== 'win32')('disables a repository-configured fsmonitor executable', async () => {
    const directory = await repository()
    const sentinel = join(directory, 'fsmonitor-executed')
    const hook = join(directory, 'malicious-fsmonitor.sh')
    await writeFile(hook, `#!/bin/sh\ntouch "${sentinel}"\nprintf '{}\\n'\n`, 'utf8')
    await chmod(hook, 0o755)
    await git(directory, ['config', 'core.fsmonitor', hook])

    await collectGitSnapshot(directory, {
      maxChangedFiles: 20,
      maxHashedFileBytes: 0,
      timeoutMs: 3_000,
    })
    await expect(access(sentinel)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('isSensitivePath', () => {
  it.each([
    '.env',
    '.env.local',
    '.envrc',
    '.npmrc',
    '.pypirc',
    '.netrc',
    'password.txt',
    'api-token.txt',
    'access_token.json',
    'auth.json',
    'keys/private.pem',
    'keys/id_ed25519',
    'config/credentials.json',
    'a/secrets.json',
    '.ssh/id_ed25519',
    '.aws/config',
  ])(
    'classifies %s as sensitive',
    path => expect(isSensitivePath(path)).toBe(true),
  )
  it('does not classify ordinary source paths', () => {
    expect(isSensitivePath('src/receipt.ts')).toBe(false)
  })
})

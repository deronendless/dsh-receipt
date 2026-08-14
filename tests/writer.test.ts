import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { buildReceipt } from '../src/receipt.js'
import type { ReceiptOptions } from '../src/types.js'
import { renderReceiptMarkdown, safeSessionDirectory, writeReceipt } from '../src/writer.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

const options: ReceiptOptions = {
  outputDir: '/unused',
  includeOutputPreview: false,
  maxOutputPreviewChars: 128,
  maxCommandChars: 1_024,
  maxChangedFiles: 20,
  maxHashedFileBytes: 1_024,
  gitTimeoutMs: 1_000,
}

function receipt(generatedAt = 200) {
  const header: SessionHeader = {
    version: 0,
    id: SessionId('../../private-session'),
    createdAt: 0,
    cwd: '/Users/alice/project',
  }
  const start = { type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } } as SessionEvent<'turn/start'>
  const end = { type: 'turn/end', seq: 1, time: 200, data: { turn: 1, reason: { kind: 'completed' } } } as SessionEvent<'turn/end'>
  return buildReceipt({
    header,
    events: [start, end],
    endEvent: end,
    observations: new Map(),
    git: { available: false, reason: 'not-a-git-repository' },
    options,
    generatedAt,
  })
}

describe('writeReceipt', () => {
  it('commits owner-only JSON and Markdown below a one-way session directory', async () => {
    const output = await mkdtemp(join(tmpdir(), 'dsh-receipt-writer-'))
    directories.push(output)
    const value = receipt()
    const written = await writeReceipt(value, output, '../../private-session')

    expect(written.directory).toContain(safeSessionDirectory('../../private-session'))
    expect(written.directory).not.toContain('../private-session')
    const parsed = JSON.parse(await readFile(written.jsonPath, 'utf8'))
    const markdown = await readFile(written.markdownPath, 'utf8')
    expect(parsed).toEqual(value)
    expect(markdown).toContain('# DSH Receipt')
    expect(markdown).toContain(value.integrity.digest)
    expect(markdown).not.toContain('../../private-session')
    if (process.platform !== 'win32') {
      expect((await stat(written.jsonPath)).mode & 0o777).toBe(0o600)
      expect((await stat(written.markdownPath)).mode & 0o777).toBe(0o600)
    }
  })

  it('is idempotent for the same digest and refuses a conflicting receipt', async () => {
    const output = await mkdtemp(join(tmpdir(), 'dsh-receipt-writer-'))
    directories.push(output)
    await writeReceipt(receipt(200), output, 'session')
    await expect(writeReceipt(receipt(200), output, 'session')).resolves.toBeDefined()
    await expect(writeReceipt(receipt(201), output, 'session')).rejects.toThrow(/refusing to overwrite a conflicting receipt/)
  })

  it('is idempotent under concurrent identical writers', async () => {
    const output = await mkdtemp(join(tmpdir(), 'dsh-receipt-writer-'))
    directories.push(output)
    const value = receipt()
    const results = await Promise.all(Array.from({ length: 20 }, () => writeReceipt(value, output, 'session')))
    expect([...new Set(results.map(result => result.jsonPath))]).toHaveLength(1)
    expect(JSON.parse(await readFile(results[0]!.jsonPath, 'utf8'))).toEqual(value)
  })

  it('rejects an invalid digest before touching disk', async () => {
    const output = await mkdtemp(join(tmpdir(), 'dsh-receipt-writer-'))
    directories.push(output)
    const value = receipt()
    value.turn.durationMs += 1
    await expect(writeReceipt(value, output, 'session')).rejects.toThrow(/invalid integrity digest/)
  })

  it('does not accept tampered existing JSON or Markdown as an idempotent write', async () => {
    const output = await mkdtemp(join(tmpdir(), 'dsh-receipt-writer-'))
    directories.push(output)
    const value = receipt()
    const written = await writeReceipt(value, output, 'session')

    await writeFile(written.markdownPath, 'tampered markdown', 'utf8')
    await expect(writeReceipt(value, output, 'session')).rejects.toThrow(/conflicting Markdown projection/)

    await writeFile(written.jsonPath, '{"integrity":{"digest":"not-valid"}}', 'utf8')
    await expect(writeReceipt(value, output, 'session')).rejects.toThrow(/existing receipt is unreadable or invalid/)
  })
})

describe('renderReceiptMarkdown', () => {
  it('renders only the already-redacted receipt model', () => {
    const markdown = renderReceiptMarkdown(receipt())
    expect(markdown).toContain('session-')
    expect(markdown).toContain('$WORKSPACE')
    expect(markdown).not.toContain('/Users/alice')
  })
})

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ReceiptPlugin from '../src/index.js'
import type { Receipt } from '../src/types.js'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadComposition(): Promise<{ loaded: Context; outputDir: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-receipt-loader-'))
  const outputDir = join(root, 'receipts')
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    '- name: dsh-receipt',
    '  config:',
    `    outputDir: ${JSON.stringify(outputDir)}`,
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = `${pathToFileURL(root).href}/`
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['dsh-receipt', ReceiptPlugin],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return { loaded: context, outputDir }
}

describe('real Loader composition', () => {
  it('loads the shipped plugin shape and writes after the awaited session flush', async () => {
    const { loaded, outputDir } = await loadComposition()
    if (root === undefined) throw new Error('test root was not initialized')

    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])

    const rawSessionId = 'loader-private-session-id'
    const session = loaded.sessions.create(SessionId(rawSessionId), { meta: { cwd: root } })
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await loaded.sessions.flush(session)

    const receiptRoot = join(outputDir, ReceiptPlugin.safeSessionDirectory(rawSessionId), 'turn-000001')
    const json = await readFile(join(receiptRoot, 'receipt.json'), 'utf8')
    const markdown = await readFile(join(receiptRoot, 'receipt.md'), 'utf8')
    const receipt = JSON.parse(json) as Receipt
    expect(ReceiptPlugin.verifyReceipt(receipt)).toBe(true)
    expect(receipt.turn.status).toBe('completed')
    expect(json).not.toContain(rawSessionId)
    expect(markdown).toContain('# DSH Receipt')
  })

  it('keeps the function-plugin namespace free of a default export', () => {
    expect('default' in ReceiptPlugin).toBe(false)
  })
})

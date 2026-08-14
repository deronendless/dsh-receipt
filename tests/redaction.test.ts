import { describe, expect, it } from 'vitest'
import { Redactor, isSensitiveKey, truncateText } from '../src/redaction.js'

describe('Redactor', () => {
  it('removes common credentials, authorization values, private keys, and home paths', () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456'
    const privateKey = '-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----'
    const redactor = new Redactor('/Users/alice')
    const output = redactor.redactString([
      `curl -H "Authorization: Bearer ${secret}" /Users/alice/project`,
      `API_TOKEN=${secret}`,
      `password: hunter2`,
      'https://alice:super-secret@example.invalid/path',
      privateKey,
      '/home/bob/another-project',
    ].join('\n'))

    expect(output).not.toContain(secret)
    expect(output).not.toContain('hunter2')
    expect(output).not.toContain('alice:super-secret')
    expect(output).not.toContain('abc123')
    expect(output).not.toContain('/Users/alice')
    expect(output).not.toContain('/home/bob')
    expect(output).toContain('[REDACTED:authorization]')
    expect(output).toContain('[REDACTED:credential]')
    expect(output).toContain('[REDACTED:private-key]')
    expect(output).toContain('https://[REDACTED:credential]@example.invalid/path')
    expect(output).toContain('~/project')
    expect(output).toContain('/home/<user>/another-project')
    expect(redactor.report().total).toBeGreaterThanOrEqual(5)
  })

  it('redacts sensitive object fields recursively without retaining their values', () => {
    const redactor = new Redactor('/safe-home')
    const output = redactor.redactValue({
      apiKey: 'low-entropy-value',
      nested: {
        password: 'also-secret',
        ordinary: 'visible',
      },
    })

    expect(output).toEqual({
      apiKey: '[REDACTED:credential]',
      nested: {
        password: '[REDACTED:credential]',
        ordinary: 'visible',
      },
    })
  })

  it('recognizes normalized sensitive key names', () => {
    expect(isSensitiveKey('client-secret')).toBe(true)
    expect(isSensitiveKey('refresh_token')).toBe(true)
    expect(isSensitiveKey('inputTokens')).toBe(false)
    expect(isSensitiveKey('output_tokens')).toBe(false)
    expect(isSensitiveKey('filePath')).toBe(false)
  })
})

describe('truncateText', () => {
  it('bounds long values and marks them', () => {
    expect(truncateText('abcdef', 4)).toEqual({ text: 'abc…', truncated: true })
    expect(truncateText('abc', 4)).toEqual({ text: 'abc', truncated: false })
  })
})

# dsh-receipt

> The agent saying “done” is a claim. A receipt is evidence.

`dsh-receipt` is a local, privacy-first plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It writes one machine-readable JSON receipt and one human-readable Markdown receipt after every observed terminal `turn/end`, including failures and cancellations.

## What a receipt contains

- Session and turn identity, terminal reason, timestamps, and duration.
- Actual provider/model provenance and last-wins token usage when DSH reports them, including usage-only failed requests and in-turn compaction calls.
- Tool names, redacted shell commands, success/failure, observed elapsed time, error code, and safe execution metadata such as exit code.
- Approval audit outcomes when approval events are present.
- Read-only Git state at turn end: branch, HEAD, changed paths, diff statistics, and optional bounded SHA-256 hashes of non-sensitive changed tracked files.
- A redaction report, explicit verification limitations, and a SHA-256 integrity digest for the receipt payload.

The plugin does **not** store prompts, full assistant messages, full tool output, environment variables, `.env` files, credentials, or private keys. File-content hashing is off by default; when explicitly enabled, it still never opens untracked files or sensitive-looking paths. Receipts are never uploaded.

## Install from npm

Requirements: Node.js `^22.19.0 || >=24` and a DSH release compatible with `0.1.0-rc.6`.

Install the stable channel into a DSH profile, verify the composed layer, and boot the profile:

```bash
dsh plugin --profile web add dsh-receipt
dsh --profile web --dump-config
dsh --profile web
```

To test the prerelease channel before it is promoted to `latest`, install `dsh-receipt@next` instead. The bundle activates itself through its packaged `cordis.patch.yml`; no manual source overlay is required.

Update or remove the package with the same profile-scoped plugin command:

```bash
dsh plugin --profile web add dsh-receipt@latest
dsh plugin --profile web remove dsh-receipt
```

## Install from a checkout

Requirements: Node.js `^22.19.0 || >=24` and a DSH release compatible with `0.1.0-rc.6`.

```bash
pnpm install
pnpm check
dsh plugin --profile web add ./
dsh --profile web --dump-config
dsh --profile web
```

Git installs must be allowed to run this package's `prepare` build, as described by the DSH plugin installation documentation. A packed tarball does not require an install-time build:

```bash
pnpm pack
dsh plugin --profile web add ./dsh-receipt-0.1.1.tgz
```

## Output

By default, receipts are written below `$DSH_HOME/receipts`; if `DSH_HOME` is unset, the root is `~/.dsh/receipts`.

```text
receipts/
└── <safe-session-name>/
    └── turn-000001/
        ├── receipt.json
        └── receipt.md
```

The directory and files are created with owner-only permissions where the platform supports POSIX modes. JSON is the authoritative artifact; Markdown is a projection of the same already-redacted data.

## Configuration

Override the bundle row in your profile's `cordis.patch.yml`:

```yaml
- id: receipt
  name: dsh-receipt
  config:
    outputDir: /absolute/local/path/to/receipts
    includeOutputPreview: false
    maxOutputPreviewChars: 512
    maxCommandChars: 4096
    maxChangedFiles: 200
    maxHashedFileBytes: 0
    gitTimeoutMs: 3000
```

`includeOutputPreview` is deliberately off by default. When enabled, only a bounded, redacted text preview is stored; the complete output is still omitted.

`maxHashedFileBytes` is also deliberately `0` by default, so Git collection uses metadata only and never opens changed file contents. Set a positive per-file cap to opt in; sensitive-looking and untracked paths remain excluded.

## Security model and limitations

- Collection is allowlist-based. Unknown tool arguments are represented only by their key names, not their values.
- Known credentials, authorization headers, private keys, sensitive object fields, and user-home paths are redacted before persistence.
- Git commands are fixed, read-only invocations executed without a shell.
- Git state is a snapshot of the whole workspace at turn end. It is evidence of state, not proof that every change was caused by that turn.
- Git collection is non-transactional; concurrent workspace changes can race the status, diff-stat, and optional hash probes.
- Tool elapsed times span DSH observations/commits and are not precise tool-body timings, especially for parallel calls.
- Usage follows DSH's per-step last-wins fold, so streaming and final samples are not double-counted; reasoning tokens are already part of output tokens.
- Only live `turn/end` events observed while the plugin is loaded produce receipts. Seeded crash-recovery history and turns completed while the plugin was unloaded are not backfilled.
- Natural-language claims are not automatically classified or verified in this MVP.
- Redaction is defense in depth, not a mathematical guarantee. Inspect a receipt before sharing it.
- The integrity digest detects accidental or later content changes; it is not a signature and does not prove that DSH or another plugin was trustworthy.
- The threat model does not defend against a malicious Harness/plugin deliberately encoding secrets into ordinary names or paths.
- Receipt writing is best-effort: failures are logged in redacted form and do not fail the agent turn or its `session/flush` checkpoint.

## Development

```bash
pnpm clean
pnpm typecheck
pnpm test
pnpm build
```

Every public publish runs `pnpm check` through `prepublishOnly`. The build removes `lib/` first so renamed or deleted source files cannot leave stale JavaScript or declaration files in the package.

## License

[MIT](./LICENSE)

DeepSeek Harness is currently a developer preview. This plugin intentionally pins its tested API line and keeps all DSH event data behind a small internal receipt model.

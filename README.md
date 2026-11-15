# pi-cancel-current-shell

A Pi extension that adds `/cancel-current-shell`.

It requests cancellation of the most recently started active built-in `bash` or
`powershell` tool execution while allowing Pi's agent turn to continue. The
cancelled shell should return a normal tool result describing the cancellation,
so the model can inspect prior output and decide what to do next.

## Requirements

- Pi with extension support.
- A Pi version that exports `createBashTool` and `createPowerShellTool` from
  `@earendil-works/pi-coding-agent`.
- Node.js runtime supported by your Pi installation.

## Install from a local folder

From the parent directory containing this package folder:

```sh
pi install ./pi-cancel-current-shell
```

For npm publication, remove no files: the included `package.json` already
contains the Pi `pi.extensions` manifest. After publishing, install it with:

```sh
pi install npm:pi-cancel-current-shell
```

Alternatively, copy the whole `pi-cancel-current-shell` folder into
`~/.pi/agent/extensions/`. Pi discovers packages with a `package.json` containing
a `pi.extensions` entry.

The extension imports the shell-tool factories from Pi's extension API
package. Pi documents this package as an available extension import. If your
Pi distribution uses a different package name/version, adjust the import to
match that distribution before installing.

Restart Pi or run `/reload`.

## Usage

While Pi is executing a shell tool, enter:

```text
/cancel-current-shell
```

The extension selects the most recently started active `bash` or `powershell`
execution and aborts its tool-level signal. It does **not** call `ctx.abort()`.

Expected flow:

1. Pi starts a shell tool call.
2. You invoke `/cancel-current-shell`.
3. The extension aborts that shell tool's signal.
4. Pi's shell implementation performs its platform-specific process cleanup.
5. The tool returns cancellation information to the model.
6. The agent continues its existing turn.

## Shell and platform behavior

The extension delegates actual shell execution and process cleanup to Pi's
`createBashTool()` and `createPowerShellTool()` implementations. This is
intentional: it avoids hardcoding `bash`, `pwsh`, `taskkill`, Unix signals, or
custom process-tree logic.

- `bash` uses Pi's configured `shellPath` and normal shell resolution.
- `powershell` uses Pi's PowerShell tool and its configured platform behavior.
- A custom executable selected through `shellPath` is supported insofar as Pi's
  Bash tool supports it.
- Windows, macOS, and Linux behavior depends on the process-management
  implementation in the installed Pi version.

This does not guarantee termination of detached processes, remote jobs,
daemonized children, or work already delegated to another service.

## Scope and limitations

- The command cancels the most recently started active shell tool call. If
  multiple shell calls are running concurrently, it targets only the newest.
- It wraps the built-in `bash` and `powershell` tools. Third-party extensions
  that replace those tools later may supersede this wrapper.
- It cannot interrupt arbitrary custom tools or shell commands started outside
  these Pi tools.
- If Pi itself aborts the whole turn (for example, via Escape), that separate
  cancellation still takes precedence.
- The wrapper passes Pi's original abort signal through to the underlying tool.
  If the agent turn is independently aborted, the original cancellation
  behavior is preserved.

## Development

The extension is TypeScript and is loaded by Pi. No build step is required.

```sh
npm install
```

## Compatibility note

Pi's extension and shell-tool APIs evolve. This package relies on the exported
`createBashTool()` and `createPowerShellTool()` factories and their `execute()`
contract. Verify those exports against the version of Pi you run before
publishing this package to npm. The package is intentionally conservative about
process management: it delegates that work to Pi rather than attempting
cross-platform signal emulation itself.

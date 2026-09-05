# Note Pi

An Obsidian plugin for desktop and mobile that opens a native-feeling chat pane backed by bundled [Pi](https://github.com/badlogic/pi-mono) agent libraries. It does not require, launch, or shell out to a `pi` binary installed on the host machine.

## Current slice

- Opens an Obsidian chat view from the command palette.
- Attaches the focused note as lightweight context when a chat session starts (removable per chat), without making the note the agent's source of truth.
- Streams status and assistant messages into the view, rendering assistant Markdown as it arrives.
- Supports Google Gemini, Anthropic, GitHub Copilot, Kimi Code, OpenAI, and OpenRouter — multiple providers can hold keys at once, and the composer model picker spans all of them.
- Stores provider API keys and tokens in the plugin's local Obsidian data file, with an in-settings connection test for each key.
- Checks Obsidian's embedded Node version against Pi's Node 22.19 runtime floor.
- Loads pi-coding-agent-compatible extensions from the vault-local Pi agent directory (see Extensions below).

## Architecture

Note Pi has three parts. `AgentController` is the product-level application layer: it receives UI intents, owns provider/session/extension policy, and publishes UI-facing snapshots and events. `PiAgentRuntime` is its thin adapter around Pi's core runtime.

| Part | Responsibility | Examples |
| --- | --- | --- |
| **Plugin configuration** | Persistent, vault-local configuration that is analogous to setting up Pi before a session. | Per-provider API key/token storage, connection testing, removing a credential, agent directory, auto-context toggle. |
| **Chat UI** | The interactive session surface. It sends user input, renders streamed output, and applies session-level harness controls. | Chat messages, cancel, composer model picker, extension slash commands; future `/model` and `/agents`. |
| **AgentController + Embedded Pi Runtime** | The application layer and bundled Pi integration. The controller applies configuration and session policy; the runtime creates Pi agents, adapts provider streaming, and exposes core tools. | `AgentController`, `PiAgentRuntime`, Pi model catalog, credentials, provider transport, transcript, cancellation. |

Obsidian's current renderer runtime cannot launch a reliable Node child process or worker thread, so this first slice loads the harness in-process behind a narrow UI-to-harness interface. This is a structural separation, not a security boundary. A future process-isolated harness remains an optional deployment evolution when the host supports it.

### Pi runtime, not Pi binary

The release bundles the JavaScript libraries `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` into `main.js`. It deliberately does **not** include the full Pi CLI/coding-agent application or a platform-specific `pi` executable.

That means:

- No host-level Pi installation, PATH entry, child process, or binary download is required.
- The controller uses `PiAgentRuntime` to access Pi's `Agent`, model catalog, provider adapters, credential abstraction, streaming events, and cancellation API directly in the Obsidian Electron process.
- Pi's interactive CLI commands, terminal UI, and host-level Pi resources are not part of this plugin slice. They require an explicit future integration rather than being inherited automatically from a local Pi installation. Vault-local extensions are the exception; see below.

**Pi agent directory:** Plugin settings stores a vault-relative `agentDir`, defaulting to `_pi/agent`; paths outside the vault are rejected. The underscore keeps the folder visible in Obsidian's file explorer. The harness receives the resolved `<vault>/_pi/agent` path and discovers extensions only from its `extensions/` directory (see below). Skills, prompts, packages, and themes remain future resource-loader work.

## Extensions

Note Pi resolves extensions the same way pi-coding-agent does, rooted at the vault-local agent directory instead of `~/.pi/agent`:

- `<agentDir>/extensions/*.ts|*.js` load directly.
- `<agentDir>/extensions/<name>/index.ts|index.js` load as subdirectory entries.
- `<agentDir>/extensions/<name>/package.json` with a `pi.extensions` field loads its declared paths.

Discovery never recurses beyond one level and never touches global Pi locations. Extensions are TypeScript or JavaScript modules whose default export is a factory function receiving a subset of Pi's `ExtensionAPI`:

```typescript
import { Type } from "typebox";

export default function (pi) {
  pi.on("session_start", async (_event, ctx) => ctx.ui.notify("loaded"));
  pi.registerTool({ name: "my_tool", description: "…", parameters: Type.Object({}), async execute(id, params) { /* … */ } });
  pi.registerCommand("mycommand", { description: "…", handler: async (args, ctx) => "result" });
}
```

Supported handlers: `session_start`, `session_shutdown`, `turn_start`, `turn_end`, `tool_call` (may return `{ block: true, reason }`), and `tool_result`. Registered tools join the agent's tool list next to the vault read tool, and `/name args` typed in the composer invokes a registered command. `typebox` and the bundled Pi packages resolve as virtual modules, so CLI-style imports work unchanged. A header chip lists loaded extensions and any load failures. The **Extensions** settings tab lists each loaded extension's name and description. Configure the Pi agent directory from the **General** tab.

This is compatible with the shared Pi extension model, not a drop-in copy of the full Coding Agent runtime. A limited compatibility shim allows common inspection extensions to import the Coding Agent's agent-directory and tool/command helpers, but terminal UI, keyboard shortcuts, CLI flags, package installation, and full Coding-Agent session/settings APIs remain unavailable because Note Pi deliberately embeds `pi-agent-core`.

Extensions execute arbitrary code with the plugin's permissions. Only place extensions you trust in the vault's agent directory.

### UI-to-harness flow

```
Plugin configuration                 Chat UI                              Embedded Pi Harness
────────────────────                 ───────                              ───────────────────
provider API keys ───────► apply persistent configuration ─────────────► configure providers + credentials
                                      │
                                      ├─ model picker / future `/model` ─► apply session model
                                      ├─ future `/agents` ───────────────► apply agent configuration
                                      ├─ send message ───────────────────► Agent.prompt()
                                      └─ Escape / cancel ────────────────► Agent.abort()
                                      ◄────────────────────────────────── Pi streaming events
                                      render message deltas
```

Note Pi settings are split into three tabs. **General** holds the agent directory, the auto-context toggle, and the response font size (12–20px, default 14px; applies to assistant messages and updates the open chat immediately). **Extensions** lists the extensions currently loaded from that directory. **API Provider** is a pure key manager: pick a provider, paste its key, and save; each stored key can be replaced, connection-tested, or removed. Multiple providers can hold keys at the same time, and key management never touches the chat session.

The composer bar contains the current model picker, the UI equivalent of a basic `/model` control. It lists the bundled Pi model catalog for every configured provider, grouped by provider. Model choice is session-only: it is held by the harness, preserves the current transcript, and is never written to Obsidian plugin data. If the active provider's key is removed, the harness falls back to any remaining configured provider.

When auto-context is enabled (the default), the currently focused note is added as a context chip at the start of each chat session. The chip is a regular context entry: remove it with its × control to exclude the note from the session, or use "Add current note" to attach a note at any time.

`/agents` and other Pi-style session controls are part of the intended Chat UI contract but are **not implemented yet**. The active note name is displayed as UI context; the current implementation does not send note contents to the model.

### Provider networking

Obsidian's renderer `fetch` is governed by Chromium's network policy and cannot reliably call all model-provider endpoints. The harness therefore sends Pi provider requests through bundled Node networking (`node-fetch`) and adapts the Node response stream to the Web-stream interface Pi expects. API keys remain in local Obsidian plugin data and each key is passed only to requests for the provider that owns it.

## Mobile (iPad/iPhone) runtime

Mobile support is a distinct runtime target. The shipped `main.js` is a universal bundle: `src/entry.ts` checks `Platform.isMobile` and lazily `require()`s the desktop or mobile subtree, so the unselected runtime's module scope — including the desktop tree's Node imports — never evaluates. (`isMobile`, not `isMobileApp`, so mobile emulation on a desktop host also exercises the mobile runtime.) The two runtimes form a parallel stack:

```
Desktop: ObsidianAgentView -> AgentController       -> PiAgentRuntime     -> pi-agent-core Agent
Mobile:  MobileAgentView  -> MobileAgentController  -> MobileAgentRuntime -> pi-agent-core Agent (validated subset)
```

The mobile runtime runs in Obsidian's iOS WebView. `npm run build` also emits `mobile.js`, the mobile subtree bundled alone with esbuild's browser platform, so `npm run verify:mobile` can prove the mobile code is free of `node:` imports, `node-fetch`, the Node execution environment, and the jiti extension loader. Its boundaries:

- **Provider transport** is per-adapter. Gemini calls use the WebView's native `fetch`: the Gemini endpoint is CORS-enabled for the `app://obsidian.md` origin, and pi-ai's Google adapters reject a custom fetch. Anthropic, Kimi Code, and OpenAI route through Obsidian's `requestUrl`, which bypasses WebView CORS restrictions. `requestUrl` buffers responses, so provider output is not token-streamed over the wire, and an in-flight HTTP request cannot be aborted (the local agent loop still cancels immediately).
- **Vault access** is a single read-only tool implemented on Obsidian's vault APIs. Every agent-supplied path is normalized and traversal/absolute paths are rejected before the vault is touched.
- **Sessions** persist through Obsidian's plugin data APIs instead of the filesystem, and resume after the view is closed and reopened.
- **Extensions, slash commands, shell tools, and write tools are excluded.** The first mobile profile is read-only by design.
- Mobile supports Google Gemini, Anthropic, Kimi Code, and OpenAI. The composer model picker spans every provider with a saved key, and picking a model from another provider switches the active provider. GitHub Copilot stays desktop-only (its OAuth device flow needs a browser handoff); OpenRouter joins after its transport is validated on-device.

On mobile the settings show only the capabilities the mobile plugin implements: the **API Provider** key manager and a **General** tab with the response font size. The agent directory, extension inventory, and auto-context controls appear only on desktop.

## Using the chat

1. Open **Note Pi settings** from the command palette.
2. In the **API Provider** tab, select a provider and save its API key or token. Repeat for as many providers as you like; the test action on each saved key probes the provider with a minimal request.
3. Run **Open Note Pi** from the command palette.
4. Choose a model in the composer bar.
5. Add note context with **Add note**, or type `@` followed by a note name; select a result to create a removable context chip.
6. Type `/` to browse commands from loaded extensions; select one to complete it in the composer.
7. Send a message. Press `Escape` while a response is streaming to cancel it, or while a suggestion list is open to dismiss the list.

The model menu spans the bundled Pi model catalogs of every provider with a saved key, grouped by provider. Each provider's credentials and model list are independent of the others.

## Development

```bash
npm install
npm run verify
```

To try it in Obsidian, install or symlink the built `main.js`, `manifest.json`, `styles.css`, and the vendored `runtime/` directory into a desktop vault's `.obsidian/plugins/note-pi/` directory, enable the plugin, open **Note Pi settings** to save a provider credential, then open the Note Pi chat and select a model. Obsidian plugin data is local storage, not OS keychain-backed secret storage.

With the Obsidian CLI enabled, `npm run deploy:testing` builds, copies the artifacts into the shared testing vault, and hot-reloads the plugin in the running app.

## Install with BRAT

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) in Obsidian.
2. Run BRAT's **Add a beta plugin for testing** command.
3. Enter `CH-YYK/note-pi` and select the latest release.

BRAT installs the release's `main.js`, `manifest.json`, and `styles.css` assets. Note Pi restores its bundled extension runtime on first load, so Pi extensions remain available in a BRAT installation.

Note Pi intentionally supports API keys and tokens only. A Gemini API key can use Google AI Studio free-tier quota when available. Kimi Code (`https://api.kimi.com/coding`) is a distinct Pi provider with its own credential and model catalog.

## Release notes

`main.js` and source maps are build artifacts and intentionally excluded from Git. A distributable plugin release must contain the built `main.js` alongside `manifest.json` and `styles.css`.

`npm run spike:surface` compares published package metadata for the minimal `pi-agent-core` path and the full `pi-coding-agent` path.

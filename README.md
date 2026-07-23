# Canvas Runtime

Canvas Runtime is a browser-local drawing canvas controlled by an external coding agent through a local MCP bridge. There is no embedded chat agent, cloud service, or model-provider configuration.

## Run locally

```sh
npm install
npm run dev
```

Configure your MCP client to start the bridge over stdio with:

```sh
npm run --silent canvas-mcp
```

The `--silent` flag keeps npm's own output off stdout. This starts the one Canvas MCP CLI process for the session: it owns both the MCP client's stdio connection and the browser bridge. After the MCP client initializes the server, the CLI opens the credentialed Canvas Runtime URL in your default browser. Set `CANVAS_AUTO_OPEN=0` in the MCP server environment to disable this behavior.

Automatic opening requires the MCP CLI to run in your local Linux, macOS, or Windows desktop session. If the OS browser command fails, the MCP server remains usable and reports a non-secret warning; open the `Canvas Runtime URL: ...` line from the MCP client's server logs instead. The URL carries a fresh loopback-only credential in its fragment; Canvas Runtime removes it after registration.

Do not first run `npm run --silent canvas-mcp` in a terminal and then configure the MCP client to run it again. Every CLI launch creates a different bridge port and token, so a URL from one process cannot connect to another process. A manual terminal launch is useful only for diagnosing startup and its stdio output; stop it before letting the MCP client launch the bridge for normal use.

The CLI reserves stdout for MCP protocol messages. Its Canvas Runtime URL and other diagnostics are written to stderr.

The bridge exposes exactly four tools:

- `canvas.get_context` — read the revisioned Canvas Item document and content bounds.
- `canvas.apply_actions` — atomically create, update, delete, or Auto-layout Canvas Items at an expected revision.
- `canvas.capture` — return a transparent PNG capture.
- `canvas.export` — return fixed-1x PNG or standalone SVG data.

The canvas remains directly editable. The status indicator shows whether the bridge is connected, reconnecting, or disconnected. After restarting the bridge, open its newly printed URL to connect the browser to the new session.

Canvas Runtime persists its document and monotonic revision under its own browser-local key. It does not read, migrate, or remove data from the former embedded-agent application.

## Checks

```sh
npm run typecheck
npm run build
npm run test:unit
npm run test:e2e
```

For release verification, follow [`docs/release-smoke-checklist.md`](docs/release-smoke-checklist.md).

# Canvas Runtime

Canvas Runtime is a browser-local drawing canvas controlled by an external coding agent through a local MCP bridge. There is no embedded chat agent, cloud service, or model-provider configuration.

## Run locally

```sh
npm install
npm run dev
```

In a second terminal, start the bridge:

```sh
npm run canvas-mcp
```

The bridge prints a one-time Canvas Runtime URL to stderr. Open it in a browser, then configure your MCP client to run `npm run canvas-mcp` over stdio. The URL carries a fresh loopback-only credential in its fragment; Canvas Runtime removes it after registration.

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

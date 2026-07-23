# Canvas Runtime release smoke checklist

Run this checklist against a production build served locally.

1. Start the app and `npm run canvas-mcp`. Confirm the Canvas Runtime URL is written only to stderr, opens the canvas, clears its fragment after registration, and the status indicator becomes connected.
2. Directly create and edit text, rectangles, ellipses, and diamonds; select, move, resize, pan, zoom, undo, and redo. With a Canvas Runtime fixture created through MCP, also verify direct selection and manipulation of its frames and Bound Arrows.
3. Through the MCP client, use `canvas.get_context`, `canvas.apply_actions`, `canvas.capture`, and `canvas.export`. Confirm a direct browser edit advances the revision seen by context, and that capture/export have transparent backgrounds with the expected geometry.
4. Reload after a direct edit and after an MCP edit. Confirm the Canvas Runtime document and revision persist.
5. Stop the bridge while editing directly. Confirm the indicator passes through reconnecting to disconnected and direct canvas editing remains available. Start a new bridge and open its newly printed URL; confirm the indicator reconnects.
6. Before loading the app, seed the former application's local-storage key (`tldraw-agent-demo`) with test data. Confirm Canvas Runtime opens blank, leaves that key unchanged, and writes only its own persisted state after an edit.
7. Inspect the production source and dependency manifest. Confirm there is no embedded chat UI, Worker or Durable Object route, model-provider configuration, streaming implementation, legacy converter/schema path, Cloudflare build configuration, or AI-provider dependency.

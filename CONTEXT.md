# External Canvas Runtime

The application exposes one browser-local drawing canvas to an external coding agent through a localhost MCP bridge.

## Language

**Canvas Runtime**:
The app-owned browser boundary that owns the private tldraw editor and translates the public canvas contract into persisted canvas changes.
_Avoid_: editor adapter, agent runtime

**Canvas Item**:
The stable, app-owned public representation of a supported drawing primitive, identified independently of its tldraw record.
_Avoid_: tldraw record, shape ID

**Bound Arrow**:
A directed connection from one distinct geometric Canvas Item (`fromId`) to another (`toId`). It cannot bind a node to itself.
_Avoid_: self-loop

**Auto-layout**:
A deterministic operation that arranges scoped geometric Canvas Items as a directed layered graph in the requested flow direction. Internal Bound Arrows determine topology; unbound text remains at absolute coordinates.
_Avoid_: free-form arrangement, force-directed layout

import { GeoShapeUtil, TextShapeUtil, Tldraw, TLUiOverrides } from 'tldraw'
import { useState } from 'react'
import { CanvasBridge, CanvasBridgeStatus } from './canvas/CanvasBridge'
import { CanvasRuntime } from './canvas/CanvasRuntime'

const canvasRuntimeTools = new Set([
	'select',
	'hand',
	'eraser',
	'text',
	'rectangle',
	'ellipse',
	'diamond',
])

const unsupportedCanvasRuntimeActions = new Set([
	'group',
	'ungroup',
	'frame-selection',
	'remove-frame',
	'fit-frame-to-content',
	'flip-horizontal',
	'flip-vertical',
	'rotate-cw',
	'rotate-ccw',
	'bring-to-front',
	'bring-forward',
	'send-backward',
	'send-to-back',
	'paste',
	'paste-at-cursor',
])

class CanvasGeoShapeUtil extends GeoShapeUtil {
	override hideRotateHandle() {
		return true
	}
}

class CanvasTextShapeUtil extends TextShapeUtil {
	override hideRotateHandle() {
		return true
	}
}

const overrides: TLUiOverrides = {
	tools: (_editor, tools) => {
		return Object.fromEntries(
			Object.entries(tools).filter(([id]) => canvasRuntimeTools.has(id))
		)
	},
	actions: (_editor, actions) => {
		return Object.fromEntries(
			Object.entries(actions).filter(([id]) => !unsupportedCanvasRuntimeActions.has(id))
		)
	},
}

function App() {
	const [bridgeStatus, setBridgeStatus] = useState<CanvasBridgeStatus>('disconnected')

	return (
		<div className="tldraw-canvas">
			<Tldraw
				overrides={overrides}
				shapeUtils={[CanvasGeoShapeUtil, CanvasTextShapeUtil]}
				components={{
					StylePanel: null,
					RichTextToolbar: null,
					ContextMenu: null,
					ActionsMenu: null,
				}}
				onMount={(editor) => {
					const runtime = new CanvasRuntime(editor)
					const bridge = CanvasBridge.connectFromLocation(
						window.location,
						async (request) => {
							if (request.tool === 'canvas.get_context') {
								return {
									version: 1,
									id: request.id,
									tool: request.tool,
									ok: true,
									result: runtime.getContext(),
								}
							}
							if (request.tool === 'canvas.apply_actions') {
								const outcome = runtime.applyActions(request.input)
								return 'code' in outcome
									? { version: 1, id: request.id, tool: request.tool, ok: false as const, error: outcome }
									: { version: 1, id: request.id, tool: request.tool, ok: true as const, result: outcome }
							}
							if (request.tool === 'canvas.capture') {
								const outcome = await runtime.capture(request.input)
								return 'code' in outcome
									? { version: 1, id: request.id, tool: request.tool, ok: false as const, error: outcome }
									: { version: 1, id: request.id, tool: request.tool, ok: true as const, result: outcome }
							}
							return {
								version: 1,
								id: request.id,
								tool: request.tool,
								ok: false as const,
								error: { code: 'validation' as const, issues: [{ message: 'Unsupported Canvas Runtime tool' }] },
							}
						},
						setBridgeStatus
					)
					const testWindow = window as Window & {
						canvasTest?: { getContext: () => ReturnType<CanvasRuntime['getContext']> }
					}
					const testFacade = import.meta.env.DEV
						? { getContext: () => runtime.getContext() }
						: undefined
					if (testFacade) testWindow.canvasTest = testFacade
					return () => {
						bridge?.dispose()
						runtime.dispose()
						if (testFacade && testWindow.canvasTest === testFacade) delete testWindow.canvasTest
					}
				}}
			/>
			<div className={`canvas-bridge-status canvas-bridge-status-${bridgeStatus}`}>
				{bridgeStatus === 'disconnected'
					? 'Bridge disconnected — reopen the URL printed by npm run canvas-mcp'
					: `Bridge ${bridgeStatus}`}
			</div>
		</div>
	)
}

export default App

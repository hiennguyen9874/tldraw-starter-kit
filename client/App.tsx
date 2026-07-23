import { GeoShapeUtil, TextShapeUtil, Tldraw, TLUiOverrides } from 'tldraw'
import { useState } from 'react'
import { CanvasToolRequest, CanvasToolResponse } from '../shared/canvas-contract'
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

type RuntimeRequest = Extract<CanvasToolRequest, { tool: 'canvas.apply_actions' | 'canvas.capture' | 'canvas.export' }>
type RuntimeOutcome =
	| ReturnType<CanvasRuntime['applyActions']>
	| Awaited<ReturnType<CanvasRuntime['capture']>>
	| Awaited<ReturnType<CanvasRuntime['export']>>

function runtimeResponse(request: RuntimeRequest, outcome: RuntimeOutcome): CanvasToolResponse {
	return 'code' in outcome
		? { version: 1, id: request.id, tool: request.tool, ok: false, error: outcome }
		: { version: 1, id: request.id, tool: request.tool, ok: true, result: outcome } as CanvasToolResponse
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
								return runtimeResponse(request, runtime.applyActions(request.input))
							}
							if (request.tool === 'canvas.capture') {
								return runtimeResponse(request, await runtime.capture(request.input))
							}
							if (request.tool === 'canvas.export') {
								return runtimeResponse(request, await runtime.export(request.input))
							}
							throw new Error(`Unsupported Canvas Runtime tool: ${String(request)}`)
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

import { GeoShapeUtil, TextShapeUtil, Tldraw, TLUiOverrides } from 'tldraw'
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
					const testWindow = window as Window & {
						canvasTest?: { getContext: () => ReturnType<CanvasRuntime['getContext']> }
					}
					const testFacade = import.meta.env.DEV
						? { getContext: () => runtime.getContext() }
						: undefined
					if (testFacade) testWindow.canvasTest = testFacade
					return () => {
						runtime.dispose()
						if (testFacade && testWindow.canvasTest === testFacade) delete testWindow.canvasTest
					}
				}}
			/>
		</div>
	)
}

export default App

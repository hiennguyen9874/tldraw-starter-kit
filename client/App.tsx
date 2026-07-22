import { Tldraw, TLUiOverrides } from 'tldraw'
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

const overrides: TLUiOverrides = {
	tools: (_editor, tools) => {
		return Object.fromEntries(
			Object.entries(tools).filter(([id]) => canvasRuntimeTools.has(id))
		)
	},
}

function App() {
	return (
		<div className="tldraw-canvas">
			<Tldraw
				overrides={overrides}
				onMount={(editor) => {
					const runtime = new CanvasRuntime(editor)
					;(window as Window & { canvasRuntime?: CanvasRuntime }).canvasRuntime = runtime
					return () => {
						runtime.dispose()
						if ((window as Window & { canvasRuntime?: CanvasRuntime }).canvasRuntime === runtime) {
							delete (window as Window & { canvasRuntime?: CanvasRuntime }).canvasRuntime
						}
					}
				}}
			/>
		</div>
	)
}

export default App

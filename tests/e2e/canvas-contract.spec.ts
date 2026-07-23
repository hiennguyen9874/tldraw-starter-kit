import { expect, test } from '@playwright/test'

interface BrowserCanvasRuntime {
	editor: BrowserEditor
	getContext(): {
		revision: number
		document: { items: Array<{ id: string; type: string; text?: string; geo?: string }> }
		contentBounds: { x: number; y: number; w: number; h: number } | null
	}
}

interface BrowserEditor {
	getCurrentPageShapes(): Array<{
		id: string
		type: string
		rotation: number
		props: Record<string, unknown>
	}>
	createShapes(shapes: Array<Record<string, unknown>>): void
	updateShapes(shapes: Array<Record<string, unknown>>): void
	select(...shapeIds: string[]): void
	setCamera(camera: { x: number; y: number; z: number }): void
	markHistoryStoppingPoint(name: string): void
	undo(): void
	redo(): void
}

async function getRuntimeContext(page: import('@playwright/test').Page) {
	return page.evaluate(
		() => (window as Window & { canvasRuntime?: BrowserCanvasRuntime }).canvasRuntime?.getContext()
	)
}

test('opens a blank Canvas Runtime without reading legacy storage', async ({ page }) => {
	await page.addInitScript(() => {
		localStorage.setItem('tldraw-agent-demo', JSON.stringify({ legacy: true }))
	})
	await page.goto('/')

	const runtimeState = await page.evaluate(() => {
		const runtime = (window as Window & { canvasRuntime?: BrowserCanvasRuntime }).canvasRuntime
		return {
			context: runtime?.getContext(),
			legacyStorage: localStorage.getItem('tldraw-agent-demo'),
			persistedRuntime: localStorage.getItem('canvas-runtime-v1'),
		}
	})

	expect(runtimeState.context).toEqual({ revision: 0, document: { items: [] }, contentBounds: null })
	expect(runtimeState.legacyStorage).toBe(JSON.stringify({ legacy: true }))
	expect(runtimeState.persistedRuntime).toBeNull()
})

test('reflects direct text edits in canonical context and persisted revision', async ({ page }) => {
	await page.goto('/')
	await expect(page.locator('.tldraw-canvas')).toBeVisible()

	const canvas = page.locator('.tl-canvas')
	await canvas.click({ position: { x: 160, y: 120 } })
	await page.keyboard.press('t')
	await canvas.click({ position: { x: 160, y: 120 } })
	await page.keyboard.type('Runtime text')
	await page.keyboard.press('Escape')

	await expect
		.poll(() =>
			page.evaluate(() => {
				const runtime = (window as Window & { canvasRuntime?: BrowserCanvasRuntime }).canvasRuntime
				return runtime?.getContext()
			})
		)
		.toMatchObject({
			revision: 1,
			document: { items: [{ type: 'text', text: 'Runtime text' }] },
		})

	const persistedRuntime = await page.evaluate(() => localStorage.getItem('canvas-runtime-v1'))
	expect(persistedRuntime).toContain('Runtime text')

	await page.reload()
	await expect
		.poll(() =>
			page.evaluate(() => {
				const runtime = (window as Window & { canvasRuntime?: BrowserCanvasRuntime }).canvasRuntime
				return runtime?.getContext()
			})
		)
		.toMatchObject({
			revision: 1,
			document: { items: [{ type: 'text', text: 'Runtime text' }] },
		})
})

test('creates supported geometric Canvas Items directly in the browser', async ({ page }) => {
	await page.goto('/')

	for (const [tool, start, end] of [
		['rectangle', { x: 100, y: 100 }, { x: 200, y: 180 }],
		['ellipse', { x: 250, y: 100 }, { x: 350, y: 180 }],
		['diamond', { x: 400, y: 100 }, { x: 500, y: 180 }],
	] as const) {
		await page.getByTestId(`tools.${tool}`).click()
		await page.mouse.move(start.x, start.y)
		await page.mouse.down()
		await page.mouse.move(end.x, end.y)
		await page.mouse.up()
	}

	await expect
		.poll(() =>
			page.evaluate(() => {
				const runtime = (window as Window & { canvasRuntime?: BrowserCanvasRuntime }).canvasRuntime
				const context = runtime?.getContext()
				return {
					revision: context?.revision,
					geos: context?.document.items
						.filter((item) => item.type === 'geo')
						.map((item) => item.geo)
						.sort(),
				}
			})
		)
		.toEqual({ revision: 3, geos: ['diamond', 'ellipse', 'rectangle'] })
})

test('rejects unsupported direct edits while preserving supported manipulation and history', async ({ page }) => {
	await page.goto('/')
	await page.getByTestId('tools.rectangle').click()
	await page.mouse.move(100, 100)
	await page.mouse.down()
	await page.mouse.move(200, 180)
	await page.mouse.up()

	await expect
		.poll(() =>
			page.evaluate(
				() =>
					(window as Window & { canvasRuntime?: BrowserCanvasRuntime }).canvasRuntime?.getContext()
						.revision
			)
		)
		.toBe(1)

	const rejectedEdit = await page.evaluate(() => {
		const runtime = (window as Window & { canvasRuntime?: BrowserCanvasRuntime }).canvasRuntime
		const editor = runtime!.editor
		const shape = editor.getCurrentPageShapes()[0]
		const originalColor = shape.props.color
		editor.updateShapes([
			{ id: shape.id, type: shape.type, rotation: Math.PI / 4, props: { ...shape.props, color: 'red' } },
		])
		const afterRejectedEdit = editor.getCurrentPageShapes()[0]
		return { rotation: afterRejectedEdit.rotation, color: afterRejectedEdit.props.color, originalColor }
	})
	expect(rejectedEdit).toEqual({ rotation: 0, color: rejectedEdit.originalColor, originalColor: rejectedEdit.originalColor })

	await page.evaluate(() => {
		const runtime = (window as Window & { canvasRuntime?: BrowserCanvasRuntime }).canvasRuntime
		const editor = runtime!.editor
		const shape = editor.getCurrentPageShapes()[0]
		editor.markHistoryStoppingPoint('supported manipulation')
		editor.updateShapes([
			{ id: shape.id, type: shape.type, x: 160, y: 140, props: { ...shape.props, w: 140, h: 100 } },
		])
	})
	await expect.poll(() => getRuntimeContext(page)).toMatchObject({
		revision: 2,
		document: { items: [{ x: 160, y: 140, w: 140, h: 100 }] },
	})

	await page.evaluate(() => {
		;(window as Window & { canvasRuntime?: BrowserCanvasRuntime }).canvasRuntime!.editor.undo()
	})
	await expect.poll(() => getRuntimeContext(page)).toMatchObject({
		revision: 3,
		document: { items: [{ x: 100, y: 100, w: 100, h: 80 }] },
	})

	await page.evaluate(() => {
		;(window as Window & { canvasRuntime?: BrowserCanvasRuntime }).canvasRuntime!.editor.redo()
	})
	await expect.poll(() => getRuntimeContext(page)).toMatchObject({
		revision: 4,
		document: { items: [{ x: 160, y: 140, w: 140, h: 100 }] },
	})

	await page.reload()
	await expect.poll(() => getRuntimeContext(page)).toMatchObject({
		revision: 4,
		document: { items: [{ x: 160, y: 140, w: 140, h: 100 }] },
	})
})

test('assigns a unique public ID when a Canvas Item is duplicated', async ({ page }) => {
	await page.goto('/')
	await page.getByTestId('tools.rectangle').click()
	await page.mouse.move(100, 100)
	await page.mouse.down()
	await page.mouse.move(200, 180)
	await page.mouse.up()

	await expect
		.poll(() =>
			page.evaluate(
				() =>
					(window as Window & { canvasRuntime?: BrowserCanvasRuntime }).canvasRuntime?.getContext()
						.revision
			)
		)
		.toBe(1)

	await page.keyboard.press('Control+d')

	await expect
		.poll(() =>
			page.evaluate(() => {
				const context = (
					window as Window & { canvasRuntime?: BrowserCanvasRuntime }
				).canvasRuntime?.getContext()
				const ids = context?.document.items.map((item) => item.id) ?? []
				return { revision: context?.revision, itemCount: ids.length, uniqueIds: new Set(ids).size }
			})
		)
		.toEqual({ revision: 2, itemCount: 2, uniqueIds: 2 })
})

test('reports tight rendered-ink bounds independently of viewport and selection', async ({ page }) => {
	await page.goto('/')

	const initialBounds = await page.evaluate(() => {
		const runtime = (window as Window & { canvasRuntime?: BrowserCanvasRuntime }).canvasRuntime!
		const editor = runtime.editor
		editor.createShapes([
			{
				id: 'shape:rendered-rectangle',
				type: 'geo',
				x: 100,
				y: 100,
				props: { geo: 'rectangle', w: 100, h: 80, richText: { type: 'doc', content: [] } },
			},
			{
				id: 'shape:rendered-ellipse',
				type: 'geo',
				x: 260,
				y: 120,
				props: { geo: 'ellipse', w: 100, h: 80, richText: { type: 'doc', content: [] } },
			},
			{
				id: 'shape:rendered-diamond',
				type: 'geo',
				x: 420,
				y: 100,
				props: { geo: 'diamond', w: 100, h: 80, richText: { type: 'doc', content: [] } },
			},
			{
				id: 'shape:rendered-text',
				type: 'text',
				x: 100,
				y: 240,
				props: {
					autoSize: true,
					richText: {
						type: 'doc',
						content: [
							{ type: 'paragraph', content: [{ type: 'text', text: 'First line' }] },
							{ type: 'paragraph', content: [{ type: 'text', text: 'Second line' }] },
						],
					},
				},
			},
		])
		return runtime.getContext().contentBounds
	})

	expect(initialBounds).toEqual({ x: 96, y: 96, w: 428, h: 208 })

	const boundsAfterViewportAndSelectionChange = await page.evaluate(() => {
		const runtime = (window as Window & { canvasRuntime?: BrowserCanvasRuntime }).canvasRuntime!
		const editor = runtime.editor
		const shapes = editor.getCurrentPageShapes()
		editor.select(...shapes.map((shape) => shape.id))
		editor.setCamera({ x: -500, y: -400, z: 2 })
		return runtime.getContext().contentBounds
	})
	expect(boundsAfterViewportAndSelectionChange).toEqual(initialBounds)
})

test('persists an edit when the page reloads before trailing synchronization', async ({ page }) => {
	await page.goto('/')
	await page.getByTestId('tools.rectangle').click()
	await page.mouse.move(100, 100)
	await page.mouse.down()
	await page.mouse.move(200, 180)
	await page.mouse.up()
	await page.reload()

	await expect
		.poll(() =>
			page.evaluate(
				() =>
					(window as Window & { canvasRuntime?: BrowserCanvasRuntime }).canvasRuntime?.getContext()
			)
		)
		.toMatchObject({ revision: 1, document: { items: [{ type: 'geo', geo: 'rectangle' }] } })
})

test('validates and canonicalizes the public Canvas Item contract in the browser', async ({ page }) => {
	await page.goto('/')
	await expect(page.locator('.tldraw-canvas')).toBeVisible()

	const result = await page.evaluate(async () => {
		const { CanvasDocumentSchema, CanvasItemPatchSchema } = await import(
			'/shared/canvas-contract.ts'
		)

		const document = CanvasDocumentSchema.parse({
			items: [
				{ id: 'node-b', type: 'geo', geo: 'ellipse', x: 120, y: 0, w: 100, h: 80 },
				{ id: 'node-a', type: 'geo', geo: 'rectangle', x: 0, y: 0, w: 100, h: 80 },
				{ id: 'arrow', type: 'arrow', fromId: 'node-a', toId: 'node-b' },
			],
		})

		let rejectsSelfLoopPatch = false
		try {
			CanvasItemPatchSchema.parse({ type: 'arrow', fromId: 'node-a', toId: 'node-a' })
		} catch {
			rejectsSelfLoopPatch = true
		}

		return { itemIds: document.items.map((item) => item.id), rejectsSelfLoopPatch }
	})

	expect(result.itemIds).toEqual(['arrow', 'node-a', 'node-b'])
	expect(result.rejectsSelfLoopPatch).toBe(true)
})

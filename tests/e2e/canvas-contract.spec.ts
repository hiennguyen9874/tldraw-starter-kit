import { expect, test } from '@playwright/test'

interface BrowserCanvasTestFacade {
	getContext(): {
		revision: number
		document: { items: Array<{ id: string; type: string; text?: string; geo?: string }> }
		contentBounds: { x: number; y: number; w: number; h: number } | null
	}
}

async function getRuntimeContext(page: import('@playwright/test').Page) {
	return page.evaluate(
		() => (window as Window & { canvasTest?: BrowserCanvasTestFacade }).canvasTest?.getContext()
	)
}

test('opens a blank Canvas Runtime without reading legacy storage', async ({ page }) => {
	await page.addInitScript(() => {
		localStorage.setItem('tldraw-agent-demo', JSON.stringify({ legacy: true }))
	})
	await page.goto('/')

	const runtimeState = await page.evaluate(() => {
		const runtime = (window as Window & { canvasTest?: BrowserCanvasTestFacade }).canvasTest
		return {
			context: runtime?.getContext(),
			legacyStorage: localStorage.getItem('tldraw-agent-demo'),
			persistedRuntime: localStorage.getItem('canvas-runtime-v1'),
		}
	})

	expect(runtimeState.context).toEqual({ revision: 0, document: { items: [] }, contentBounds: null })
	expect(await page.evaluate(() => ({
		facadeMethods: Object.keys((window as Window & { canvasTest?: object }).canvasTest ?? {}),
		canvasRuntime: (window as Window & { canvasRuntime?: unknown }).canvasRuntime,
	}))).toEqual({ facadeMethods: ['getContext'], canvasRuntime: undefined })
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

	const immediateContext = await getRuntimeContext(page)
	expect(immediateContext).toMatchObject({
		revision: 1,
		document: { items: [{ type: 'text', text: 'Runtime text' }] },
		contentBounds: expect.any(Object),
	})

	const persistedRuntime = await page.evaluate(() => localStorage.getItem('canvas-runtime-v1'))
	expect(persistedRuntime).toContain('Runtime text')
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
				const runtime = (window as Window & { canvasTest?: BrowserCanvasTestFacade }).canvasTest
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
					(window as Window & { canvasTest?: BrowserCanvasTestFacade }).canvasTest?.getContext()
						.revision
			)
		)
		.toBe(1)

	await page.keyboard.press('Control+d')

	await expect
		.poll(() =>
			page.evaluate(() => {
				const context = (
					window as Window & { canvasTest?: BrowserCanvasTestFacade }
				).canvasTest?.getContext()
				const ids = context?.document.items.map((item) => item.id) ?? []
				return { revision: context?.revision, itemCount: ids.length, uniqueIds: new Set(ids).size }
			})
		)
		.toEqual({ revision: 2, itemCount: 2, uniqueIds: 2 })
})

test('reports rendered-ink content bounds through the Canvas Item facade', async ({ page }) => {
	await page.goto('/')
	await page.getByTestId('tools.rectangle').click()
	await page.mouse.move(100, 100)
	await page.mouse.down()
	await page.mouse.move(200, 180)
	await page.mouse.up()

	expect((await getRuntimeContext(page))?.contentBounds).toEqual({ x: 96, y: 96, w: 108, h: 88 })
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
					(window as Window & { canvasTest?: BrowserCanvasTestFacade }).canvasTest?.getContext()
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

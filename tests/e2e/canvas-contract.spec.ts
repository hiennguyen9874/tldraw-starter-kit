import { expect, test } from '@playwright/test'

interface BrowserCanvasRuntime {
	getContext(): {
		revision: number
		document: { items: Array<{ id: string; type: string; text?: string; geo?: string }> }
		contentBounds: { x: number; y: number; w: number; h: number } | null
	}
}

test('opens a blank Canvas Runtime without reading legacy storage', async ({ page }) => {
	await page.addInitScript(() => {
		localStorage.setItem('tldraw-agent-demo', JSON.stringify({ legacy: true }))
	})
	await page.goto('/')

	const context = await page.evaluate(() => {
		const runtime = (window as Window & { canvasRuntime?: BrowserCanvasRuntime }).canvasRuntime
		return {
			context: runtime?.getContext(),
			legacyStorage: localStorage.getItem('tldraw-agent-demo'),
			persistedRuntime: localStorage.getItem('canvas-runtime-v1'),
		}
	})

	expect(context.context).toEqual({ revision: 0, document: { items: [] }, contentBounds: null })
	expect(context.legacyStorage).toBe(JSON.stringify({ legacy: true }))
	expect(context.persistedRuntime).toBeNull()
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
				return runtime
					?.getContext()
					.document.items.filter((item) => item.type === 'geo')
					.map((item) => item.geo)
					.sort()
			})
		)
		.toEqual(['diamond', 'ellipse', 'rectangle'])
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

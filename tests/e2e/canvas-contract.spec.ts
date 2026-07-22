import { expect, test } from '@playwright/test'

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

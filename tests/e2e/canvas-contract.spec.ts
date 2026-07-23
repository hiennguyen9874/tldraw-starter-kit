import { expect, test as base } from '@playwright/test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { resolve } from 'node:path'

interface BrowserCanvasTestFacade {
	getContext(): {
		revision: number
		document: {
			items: Array<{ id: string; type: string; text?: string; geo?: string; memberIds?: string[] }>
		}
		contentBounds: { x: number; y: number; w: number; h: number } | null
	}
}

async function getRuntimeContext(page: import('@playwright/test').Page) {
	return page.evaluate(
		() => (window as Window & { canvasTest?: BrowserCanvasTestFacade }).canvasTest?.getContext()
	)
}

function startMcpCli() {
	return spawn(process.execPath, [resolve('cli/canvas-mcp.mjs')], {
		stdio: ['pipe', 'pipe', 'pipe'],
		env: { ...process.env, CANVAS_URL: 'http://127.0.0.1:4173/' },
	})
}

type McpCli = ReturnType<typeof startMcpCli>

interface McpCanvasFixture {
	cli: McpCli
	canvasUrl: string
	call(id: string, arguments_: object): Promise<unknown>
	context(id: string): Promise<unknown>
	tool(id: string, name: string, arguments_: object): Promise<unknown>
}

const test = base.extend<{ mcpCanvas: McpCanvasFixture }>({
	mcpCanvas: async ({ page }, use) => {
		const cli = startMcpCli()
		let stderr = ''
		cli.stderr.setEncoding('utf8')
		cli.stderr.on('data', (chunk) => {
			stderr += chunk
		})

		try {
			await expect.poll(() => stderr.match(/Canvas Runtime URL: (.+)/)?.[1]).toBeTruthy()
			const canvasUrl = stderr.match(/Canvas Runtime URL: (.+)/)?.[1]
			if (!canvasUrl) throw new Error('Canvas MCP CLI did not print a Canvas Runtime URL')
			await page.goto(canvasUrl)
			await expect(page.getByText('Bridge connected')).toBeVisible()

			await use({
				cli,
				canvasUrl,
				call: (id, arguments_) =>
					sendMcpRequest(cli, {
						jsonrpc: '2.0',
						id,
						method: 'tools/call',
						params: { name: 'canvas.apply_actions', arguments: arguments_ },
					}),
				context: (id) =>
					sendMcpRequest(cli, {
						jsonrpc: '2.0',
						id,
						method: 'tools/call',
						params: { name: 'canvas.get_context', arguments: {} },
					}),
				tool: (id, name, arguments_) =>
					sendMcpRequest(cli, {
						jsonrpc: '2.0',
						id,
						method: 'tools/call',
						params: { name, arguments: arguments_ },
					}),
			})
		} finally {
			await stopMcpCli(cli)
		}
	},
})

async function stopMcpCli(cli: McpCli) {
	if (cli.exitCode !== null || cli.signalCode !== null) return
	const exit = once(cli, 'exit')
	cli.kill()
	await exit
}

test('gets canonical Canvas Runtime context through the real stdio MCP bridge', async ({
	page,
	mcpCanvas: { cli, canvasUrl },
}) => {
	expect(await page.evaluate(() => window.location.hash)).toBe('')

	const response = await sendMcpRequest(cli, {
		jsonrpc: '2.0',
		id: 'context-1',
		method: 'tools/call',
		params: { name: 'canvas.get_context', arguments: {} },
	})
	expect(response).toEqual({
		jsonrpc: '2.0',
		id: 'context-1',
		result: {
			content: [{ type: 'text', text: JSON.stringify({ revision: 0, document: { items: [] }, contentBounds: null }) }],
			structuredContent: { revision: 0, document: { items: [] }, contentBounds: null },
		},
	})

	const replacementPage = await page.context().newPage()
	await replacementPage.goto(canvasUrl)
	await expect(replacementPage.getByText('Bridge connected')).toBeVisible()
	await expect(page.getByText(/Bridge disconnected — reopen/)).toBeVisible()
	await replacementPage.waitForTimeout(2_000)
	await expect(replacementPage.getByText('Bridge connected')).toBeVisible()

	await stopMcpCli(cli)
	await expect(replacementPage.getByText('Bridge reconnecting')).toBeVisible()
	await expect(replacementPage.getByText(/Bridge disconnected — reopen/)).toBeVisible({
		timeout: 5_000,
	})
})

test('captures transparent Canvas Runtime PNGs through the real MCP bridge', async ({
	page,
	mcpCanvas: { call, tool },
}) => {
	const empty = await tool('capture-empty', 'canvas.capture', {})
	expect(empty).toMatchObject({
		result: {
			content: [
				{ type: 'image', mimeType: 'image/png' },
				{ type: 'text', text: JSON.stringify({ revision: 0, rect: { x: 0, y: 0, w: 1, h: 1 } }) },
			],
			structuredContent: { revision: 0, rect: { x: 0, y: 0, w: 1, h: 1 } },
		},
	})
	expect(pngDimensions(captureData(empty))).toEqual({ width: 1, height: 1 })
	expect(await pngPixelAlpha(page, captureData(empty))).toBe(0)

	const emptyClipped = await tool('capture-empty-clipped', 'canvas.capture', { rect: { x: 1, y: 2, w: 3, h: 4 } })
	expect(emptyClipped).toMatchObject({
		result: { structuredContent: { revision: 0, rect: { x: 1, y: 2, w: 3, h: 4 } } },
	})
	expect(pngDimensions(captureData(emptyClipped))).toEqual({ width: 3, height: 4 })
	expect(await pngPixelAlpha(page, captureData(emptyClipped))).toBe(0)

	await call('create-capture-node', {
		expectedRevision: 0,
		actions: [
			{ type: 'create', item: { id: 'node', type: 'geo', geo: 'rectangle', x: 100, y: 100, w: 100, h: 80 } },
		],
	})
	const padded = await tool('capture-padded', 'canvas.capture', {})
	expect(padded).toMatchObject({
		result: {
			structuredContent: { revision: 1, rect: { x: 64, y: 64, w: 172, h: 152 } },
		},
	})
	expect(pngDimensions(captureData(padded))).toEqual({ width: 172, height: 152 })

	const clipped = await tool('capture-clipped', 'canvas.capture', { rect: { x: 1, y: 2, w: 3, h: 4 } })
	expect(clipped).toMatchObject({
		result: { structuredContent: { revision: 1, rect: { x: 1, y: 2, w: 3, h: 4 } } },
	})
	expect(pngDimensions(captureData(clipped))).toEqual({ width: 3, height: 4 })

	expect(await tool('capture-stale', 'canvas.capture', { expectedRevision: 0 })).toMatchObject({
		result: { isError: true, structuredContent: { error: { code: 'stale_revision', expectedRevision: 0, currentRevision: 1 } } },
	})
	expect(await tool('capture-invalid-rect', 'canvas.capture', { rect: { x: 0, y: 0, w: 0, h: 1 } })).toMatchObject({
		result: { isError: true, structuredContent: { error: { code: 'validation', issues: [{ field: 'rect.w' }] } } },
	})
	expect(await tool('capture-oversized', 'canvas.capture', { rect: { x: 0, y: 0, w: 4_001, h: 4_000 } })).toMatchObject({
		result: { isError: true, structuredContent: { error: { code: 'validation', issues: [{ field: 'rect' }] } } },
	})

	await page.evaluate(() => {
		const toBlob = HTMLCanvasElement.prototype.toBlob
		HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
			toBlob.call(this, (blob) => {
				callback(blob && new Blob([blob, new Uint8Array(16 * 1024 * 1024)], { type: blob.type }))
			}, ...args)
		}
	})
	expect(await tool('capture-oversized-payload', 'canvas.capture', { rect: { x: 0, y: 0, w: 1, h: 1 } })).toMatchObject({
		result: { isError: true, structuredContent: { error: { code: 'validation', issues: [{ field: 'content.data' }] } } },
	})
})

test('exports fixed-1x transparent PNG and standalone SVG data through the real MCP bridge', async ({
	page,
	mcpCanvas: { call, tool },
}) => {
	for (const format of ['png', 'svg'] as const) {
		const empty = await tool(`export-empty-${format}`, 'canvas.export', { format })
		expect(empty).toMatchObject({
			result: {
				structuredContent: {
					revision: 0,
					rect: { x: 0, y: 0, w: 1, h: 1 },
					mimeType: format === 'png' ? 'image/png' : 'image/svg+xml',
				},
			},
		})
		const data = exportData(empty)
		if (format === 'png') {
			expect(pngDimensions(data)).toEqual({ width: 1, height: 1 })
			expect(await pngPixelAlpha(page, data)).toBe(0)
		} else {
			expect(svgViewBox(data)).toBe('0 0 1 1')
			expect(svgHasExternalAssets(data)).toBe(false)
		}
	}

	await call('create-export-node', {
		expectedRevision: 0,
		actions: [
			{ type: 'create', item: { id: 'node', type: 'geo', geo: 'rectangle', x: 100, y: 100, w: 100, h: 80 } },
		],
	})

	const rect = { x: 10, y: 20, w: 30, h: 40 }
	const png = await tool('export-png', 'canvas.export', { format: 'png', expectedRevision: 1, rect })
	expect(png).toMatchObject({
		result: { structuredContent: { revision: 1, rect, mimeType: 'image/png' } },
	})
	expect(pngDimensions(exportData(png))).toEqual({ width: 30, height: 40 })

	const svg = await tool('export-svg', 'canvas.export', { format: 'svg', expectedRevision: 1, rect })
	expect(svg).toMatchObject({
		result: { structuredContent: { revision: 1, rect, mimeType: 'image/svg+xml' } },
	})
	expect(svgViewBox(exportData(svg))).toBe('10 20 30 40')
	expect(svgHasExternalAssets(exportData(svg))).toBe(false)

	expect(await tool('export-stale', 'canvas.export', { format: 'png', expectedRevision: 0 })).toMatchObject({
		result: { isError: true, structuredContent: { error: { code: 'stale_revision', expectedRevision: 0, currentRevision: 1 } } },
	})
	expect(await tool('export-invalid-rect', 'canvas.export', { format: 'svg', rect: { x: 0, y: 0, w: 0, h: 1 } })).toMatchObject({
		result: { isError: true, structuredContent: { error: { code: 'validation', issues: [{ field: 'rect.w' }] } } },
	})
	expect(await tool('export-oversized', 'canvas.export', { format: 'png', rect: { x: 0, y: 0, w: 4_001, h: 4_000 } })).toMatchObject({
		result: { isError: true, structuredContent: { error: { code: 'validation', issues: [{ field: 'rect' }] } } },
	})

	await page.evaluate(() => {
		const toBlob = HTMLCanvasElement.prototype.toBlob
		HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
			toBlob.call(this, (blob) => {
				callback(blob && new Blob([blob, new Uint8Array(16 * 1024 * 1024)], { type: blob.type }))
			}, ...args)
		}
	})
	expect(await tool('export-oversized-payload', 'canvas.export', { format: 'png', rect: { x: 0, y: 0, w: 1, h: 1 } })).toMatchObject({
		result: { isError: true, structuredContent: { error: { code: 'validation', issues: [{ field: 'data' }] } } },
	})
})

function exportData(response: unknown) {
	const data = (response as { result: { structuredContent: { data?: string } } }).result.structuredContent.data
	if (!data) throw new Error('Export did not return base64 data')
	return data
}

function svgViewBox(base64: string) {
	return Buffer.from(base64, 'base64').toString('utf8').match(/viewBox="([^"]+)"/)?.[1]
}

function svgHasExternalAssets(base64: string) {
	const svg = Buffer.from(base64, 'base64').toString('utf8')
	return /(?:href|src)="(?!data:|#)[^"]+"/.test(svg) || /url\((?!['"]?(?:data:|#))/.test(svg)
}

function captureData(response: unknown) {
	const result = (response as { result: { content: Array<{ data?: string }> } }).result
	const data = result.content[0]?.data
	if (!data) throw new Error('Capture did not return MCP image data')
	return data
}

function pngDimensions(base64: string) {
	const png = Buffer.from(base64, 'base64')
	return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

function pngPixelAlpha(page: import('@playwright/test').Page, base64: string) {
	return page.evaluate(async (data) => {
		const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob())
		const canvas = document.createElement('canvas')
		canvas.width = bitmap.width
		canvas.height = bitmap.height
		canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
		return canvas.getContext('2d')?.getImageData(0, 0, 1, 1).data[3]
	}, base64)
}

test('applies a forward-referenced Canvas Item batch through the real MCP bridge', async ({
	mcpCanvas: { cli },
}) => {
	const response = await sendMcpRequest(cli, {
			jsonrpc: '2.0',
			id: 'actions-1',
			method: 'tools/call',
			params: {
				name: 'canvas.apply_actions',
				arguments: {
					expectedRevision: 0,
					actions: [
						{ type: 'create', item: { id: 'group', type: 'frame', x: 0, y: 0, w: 400, h: 200, memberIds: ['node-a', 'node-b'] } },
						{ type: 'create', item: { id: 'edge', type: 'arrow', fromId: 'node-a', toId: 'node-b' } },
						{ type: 'create', item: { id: 'node-a', type: 'geo', geo: 'rectangle', x: 0, y: 0, w: 100, h: 80 } },
						{ type: 'create', item: { id: 'node-b', type: 'geo', geo: 'ellipse', x: 200, y: 0, w: 100, h: 80 } },
					],
				},
			},
	})
	expect(response).toMatchObject({
		result: {
			structuredContent: {
				revision: 1,
				changedIds: ['group', 'edge', 'node-a', 'node-b'],
				deletedIds: [],
			},
		},
	})
})

test('lays out Canvas Items through the real MCP bridge', async ({
	mcpCanvas: { call, context },
}) => {
	await call('create-layout-topology', {
		expectedRevision: 0,
		actions: [
			{ type: 'create', item: { id: 'edge', type: 'arrow', fromId: 'node-a', toId: 'node-b' } },
			{ type: 'create', item: { id: 'node-a', type: 'geo', geo: 'rectangle', x: 500, y: 100, w: 80, h: 60 } },
			{ type: 'create', item: { id: 'node-b', type: 'geo', geo: 'ellipse', x: 100, y: 300, w: 100, h: 40 } },
		],
	})

	const layout = await call('layout', {
		expectedRevision: 1,
		actions: [{ type: 'layout', direction: 'left-to-right', scope: { type: 'all' } }],
	})
	expect(layout).toMatchObject({
		result: { structuredContent: { revision: 2, changedIds: ['node-a', 'node-b', 'edge'], deletedIds: [] } },
	})
	expect(await context('layout-context')).toMatchObject({
		result: {
			structuredContent: {
				revision: 2,
				document: {
					items: [
						{ id: 'edge', type: 'arrow', fromId: 'node-a', toId: 'node-b' },
						{ id: 'node-a', type: 'geo', x: 100, y: 100, w: 80, h: 60 },
						{ id: 'node-b', type: 'geo', x: 300, y: 100, w: 100, h: 40 },
					],
				},
			},
		},
	})
})

test('lays out a forward-referenced scope and preserves its observable Bound Arrow through MCP context', async ({
	mcpCanvas: { call, context },
}) => {
	const layout = await call('forward-layout', {
		expectedRevision: 0,
		actions: [
			{ type: 'layout', direction: 'left-to-right', scope: { type: 'items', itemIds: ['node-a', 'node-b'] } },
			{ type: 'create', item: { id: 'edge', type: 'arrow', fromId: 'node-a', toId: 'node-b' } },
			{ type: 'create', item: { id: 'node-a', type: 'geo', geo: 'rectangle', x: 500, y: 100, w: 80, h: 60 } },
			{ type: 'create', item: { id: 'node-b', type: 'geo', geo: 'ellipse', x: 100, y: 300, w: 100, h: 40 } },
		],
	})
	expect(layout).toMatchObject({
		result: { structuredContent: { revision: 1, changedIds: ['edge', 'node-a', 'node-b'], deletedIds: [] } },
	})
	expect(await context('forward-layout-context')).toMatchObject({
		result: {
			structuredContent: {
				revision: 1,
				document: {
					items: [
						{ id: 'edge', type: 'arrow', fromId: 'node-a', toId: 'node-b' },
						{ id: 'node-a', type: 'geo', x: 100, y: 100, w: 80, h: 60 },
						{ id: 'node-b', type: 'geo', x: 300, y: 100, w: 100, h: 40 },
					],
				},
			},
		},
	})
})

test('deletes direct Canvas Items, including multi-selections, through shared actions', async ({
	page,
	mcpCanvas: { call, context },
}) => {
	await call('create-topology', {
		expectedRevision: 0,
		actions: [
			{
				type: 'create',
				item: { id: 'group', type: 'frame', x: 50, y: 50, w: 500, h: 200, memberIds: ['node-a'] },
			},
			{
				type: 'create',
				item: { id: 'edge', type: 'arrow', fromId: 'node-a', toId: 'node-b' },
			},
			{
				type: 'create',
				item: { id: 'node-a', type: 'geo', geo: 'rectangle', x: 100, y: 100, w: 100, h: 80 },
			},
			{
				type: 'create',
				item: { id: 'node-b', type: 'geo', geo: 'ellipse', x: 400, y: 100, w: 100, h: 80 },
			},
		],
	})

	await page.mouse.click(120, 120)
	await page.keyboard.press('Delete')

	await expect.poll(() => context('direct-delete-single')).toMatchObject({
		result: {
			structuredContent: {
				revision: 2,
				document: {
					items: [
						{ id: 'group', type: 'frame', memberIds: [] },
						{ id: 'node-b', type: 'geo' },
					],
				},
			},
		},
	})

	await page.keyboard.press('Control+a')
	await page.keyboard.press('Delete')

	await expect.poll(() => context('direct-delete-multiple')).toMatchObject({
		result: {
			structuredContent: {
				revision: 3,
				document: { items: [] },
			},
		},
	})
})

test('rejects invalid and stale batches without creating a Canvas Runtime history entry', async ({
	page,
	mcpCanvas: { call, context },
}) => {
	await call('create', { expectedRevision: 0, actions: [
		{ type: 'create', item: { id: 'label', type: 'text', x: 0, y: 0, text: 'Draft' } },
		{ type: 'create', item: { id: 'obsolete', type: 'text', x: 0, y: 100, text: 'Remove me' } },
	] })
	const updated = await call('update-delete', { expectedRevision: 1, actions: [
		{ type: 'update', id: 'label', patch: { type: 'text', text: 'Published' } },
		{ type: 'delete', id: 'obsolete' },
	] })
	expect(updated).toMatchObject({ result: { structuredContent: { revision: 2, changedIds: ['label'], deletedIds: ['obsolete'] } } })

	const invalid = await call('invalid', { expectedRevision: 2, actions: [
		{ type: 'create', item: { id: 'broken', type: 'arrow', fromId: 'missing', toId: 'label' } },
	] })
	expect(invalid).toMatchObject({ result: { isError: true, structuredContent: { error: { code: 'validation', issues: [{ actionIndex: 0, field: 'item.fromId' }] } } } })
	const invalidField = await call('invalid-field', { expectedRevision: 2, actions: [{ type: 'create', item: { id: 'bad-size', type: 'geo', geo: 'rectangle', x: 0, y: 0, w: -1, h: -1 } }] })
	expect(invalidField).toMatchObject({ result: { isError: true, structuredContent: { error: { code: 'validation', issues: [{ actionIndex: 0, field: 'item.w' }] } } } })
	expect((invalidField as { result: { structuredContent: { error: { issues: unknown[] } } } }).result.structuredContent.error.issues).toHaveLength(1)
	const invalidLayout = await call('invalid-layout', {
		expectedRevision: 2,
		actions: [{ type: 'layout', direction: 'left-to-right', scope: { type: 'items', itemIds: ['label'] } }],
	})
	expect(invalidLayout).toMatchObject({ result: { isError: true, structuredContent: { error: { code: 'validation', issues: [{ actionIndex: 0, field: 'scope.itemIds.0' }] } } } })
	expect(await context('unchanged')).toMatchObject({ result: { structuredContent: { revision: 2, document: { items: [{ id: 'label', type: 'text', text: 'Published', x: 0, y: 0 }] } } } })

	await page.keyboard.press('Control+z')
	expect(await context('undo')).toMatchObject({ result: { structuredContent: { revision: 3, document: { items: [{ id: 'label', type: 'text', text: 'Draft', x: 0, y: 0 }, { id: 'obsolete', type: 'text', text: 'Remove me', x: 0, y: 100 }] } } } })
	const stale = await call('stale', { expectedRevision: 0, actions: [{ type: 'delete', id: 'label' }] })
	expect(stale).toMatchObject({ result: { isError: true, structuredContent: { error: { code: 'stale_revision', expectedRevision: 0, currentRevision: 3 } } } })
})

function sendMcpRequest(
	cli: McpCli,
	request: Record<string, unknown>
): Promise<unknown> {
	return new Promise((resolveResponse, reject) => {
		const timeout = setTimeout(() => reject(new Error('Timed out waiting for MCP response')), 5_000)
		cli.stdout.once('data', (chunk) => {
			clearTimeout(timeout)
			resolveResponse(JSON.parse(chunk.toString()))
		})
		cli.stdin.write(`${JSON.stringify(request)}\n`)
	})
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

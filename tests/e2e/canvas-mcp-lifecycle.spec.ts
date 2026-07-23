import { expect, test } from '@playwright/test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { resolve } from 'node:path'

class McpBridgeHarness {
	readonly cli = spawn(process.execPath, [resolve('cli/canvas-mcp.mjs')], {
		stdio: ['pipe', 'pipe', 'pipe'],
		env: {
			...process.env,
			CANVAS_URL: 'http://127.0.0.1:4173/',
			CANVAS_AUTO_OPEN: '0',
			NODE_ENV: 'test',
			CANVAS_BRIDGE_TEST_TIMEOUT_MS: '100',
		},
	})
	stderr = ''
	private stdout = ''
	private readonly responses = new Map<string, (response: Record<string, unknown>) => void>()

	constructor() {
		this.cli.stderr.setEncoding('utf8')
		this.cli.stderr.on('data', (chunk) => {
			this.stderr += chunk
		})
		this.cli.stdout.setEncoding('utf8')
		this.cli.stdout.on('data', (chunk) => {
			this.stdout += chunk
			let newline = this.stdout.indexOf('\n')
			while (newline !== -1) {
				const response = JSON.parse(this.stdout.slice(0, newline)) as Record<string, unknown>
				this.stdout = this.stdout.slice(newline + 1)
				this.responses.get(String(response.id))?.(response)
				this.responses.delete(String(response.id))
				newline = this.stdout.indexOf('\n')
			}
		})
	}

	get canvasUrl() {
		return this.stderr.match(/Canvas Runtime URL: (.+)/)?.[1]
	}

	initialize(id: string) {
		return this.send(id, {
			jsonrpc: '2.0',
			id,
			method: 'initialize',
			params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
		})
	}

	request(id: string, name = 'canvas.get_context') {
		return this.send(id, {
			jsonrpc: '2.0',
			id,
			method: 'tools/call',
			params: { name, arguments: {} },
		})
	}

	listTools(id: string) {
		return this.send(id, { jsonrpc: '2.0', id, method: 'tools/list' })
	}

	private send(id: string, request: Record<string, unknown>) {
		return new Promise<Record<string, unknown>>((resolveResponse, reject) => {
			const timeout = setTimeout(() => reject(new Error(`Timed out waiting for MCP response ${id}`)), 5_000)
			this.responses.set(id, (response) => {
				clearTimeout(timeout)
				resolveResponse(response)
			})
			this.cli.stdin.write(`${JSON.stringify(request)}\n`)
		})
	}

	async stop() {
		if (this.cli.exitCode !== null) return
		const exit = once(this.cli, 'exit')
		this.cli.kill()
		await exit
	}
}

class FakeRuntime {
	private readonly messages: Record<string, unknown>[] = []
	private readonly waiters: Array<(message: Record<string, unknown>) => void> = []

	private constructor(readonly socket: WebSocket) {
		socket.addEventListener('message', (event) => {
			const message = JSON.parse(String(event.data)) as Record<string, unknown>
			const waiter = this.waiters.shift()
			if (waiter) waiter(message)
			else this.messages.push(message)
		})
	}

	static async connect(canvasUrl: string, tokenOverride?: string, registrationPayload?: string) {
		const url = new URL(canvasUrl)
		const port = new URLSearchParams(url.hash.slice(1)).get('canvas-bridge-port')
		const token = tokenOverride ?? new URLSearchParams(url.hash.slice(1)).get('canvas-bridge-token')
		if (!port || !token) throw new Error('Canvas URL has no bridge credentials')
		const socket = new WebSocket(`ws://127.0.0.1:${port}`)
		const runtime = new FakeRuntime(socket)
		await new Promise<void>((resolveOpen, reject) => {
			socket.addEventListener('open', () => resolveOpen(), { once: true })
			socket.addEventListener('error', () => reject(new Error('WebSocket failed to open')), {
				once: true,
			})
		})
		socket.send(registrationPayload ?? JSON.stringify({ version: 1, type: 'register', token }))
		return runtime
	}

	nextMessage() {
		const message = this.messages.shift()
		if (message) return Promise.resolve(message)
		return new Promise<Record<string, unknown>>((resolveMessage, reject) => {
			const timeout = setTimeout(() => reject(new Error('Timed out waiting for runtime message')), 5_000)
			this.waiters.push((nextMessage) => {
				clearTimeout(timeout)
				resolveMessage(nextMessage)
			})
		})
	}

	sendResponse(id: string, result: unknown) {
		this.socket.send(
			JSON.stringify({
				version: 1,
				type: 'response',
				response: { version: 1, id, tool: 'canvas.get_context', ok: true, result },
			})
		)
	}

	waitForClose() {
		if (this.socket.readyState === WebSocket.CLOSED) return Promise.resolve()
		return new Promise<void>((resolveClose) => {
			this.socket.addEventListener('close', () => resolveClose(), { once: true })
		})
	}
}

function bridgeRequestId(message: Record<string, unknown>) {
	return String((message.request as Record<string, unknown>).id)
}

function errorCode(response: Record<string, unknown>) {
	const result = response.result as Record<string, unknown>
	const structuredContent = result.structuredContent as Record<string, unknown>
	return (structuredContent.error as Record<string, unknown>).code
}

test('enforces the Canvas Runtime bridge lifecycle and supports large context responses', async () => {
	const bridge = new McpBridgeHarness()
	try {
		await expect.poll(() => bridge.canvasUrl).toBeTruthy()
		const canvasUrl = bridge.canvasUrl
		if (!canvasUrl) throw new Error('CLI did not print a Canvas Runtime URL')

		expect((await bridge.initialize('initialize')).result).toMatchObject({
			protocolVersion: '2025-03-26',
			capabilities: { logging: {}, tools: {} },
		})
		expect(
			((await bridge.listTools('tools-list')).result as { tools: Array<{ name: string }> }).tools.map(
				(tool) => tool.name
			)
		).toEqual(['canvas.get_context', 'canvas.apply_actions', 'canvas.capture', 'canvas.export'])
		expect(errorCode(await bridge.request('unavailable'))).toBe('unavailable')
		expect(errorCode(await bridge.request('validation', 'unknown-tool'))).toBe('validation')

		const token = new URLSearchParams(new URL(canvasUrl).hash.slice(1)).get('canvas-bridge-token')
		if (!token) throw new Error('Canvas URL has no bridge token')
		const malformedRuntime = await FakeRuntime.connect(canvasUrl, undefined, '{')
		await malformedRuntime.waitForClose()
		const malformedEnvelopeRuntime = await FakeRuntime.connect(
			canvasUrl,
			undefined,
			JSON.stringify({ version: 1, type: 'register', token, extra: true })
		)
		await malformedEnvelopeRuntime.waitForClose()
		const outOfOrderRuntime = await FakeRuntime.connect(
			canvasUrl,
			undefined,
			JSON.stringify({ version: 1, type: 'response', response: {} })
		)
		await outOfOrderRuntime.waitForClose()
		const incompatibleRuntime = await FakeRuntime.connect(
			canvasUrl,
			undefined,
			JSON.stringify({ version: 2, type: 'register', token })
		)
		await incompatibleRuntime.waitForClose()
		const invalidRuntime = await FakeRuntime.connect(canvasUrl, 'invalid-token')
		await invalidRuntime.waitForClose()
		expect(errorCode(await bridge.request('still-unavailable'))).toBe('unavailable')

		const firstRuntime = await FakeRuntime.connect(canvasUrl)
		expect(await firstRuntime.nextMessage()).toMatchObject({ type: 'registered' })
		const firstCall = bridge.request('first')
		const firstRequest = await firstRuntime.nextMessage()
		expect(errorCode(await bridge.request('busy'))).toBe('busy')
		const largeContext = {
			revision: 1,
			document: { items: [{ id: 'large-text', type: 'text', x: 0, y: 0, text: 'x'.repeat(70_000) }] },
			contentBounds: null,
		}
		firstRuntime.sendResponse(bridgeRequestId(firstRequest), largeContext)
		expect((await firstCall).result).toMatchObject({ structuredContent: largeContext })

		const replacedCall = bridge.request('replaced')
		await firstRuntime.nextMessage()
		const secondRuntime = await FakeRuntime.connect(canvasUrl)
		expect(await firstRuntime.nextMessage()).toMatchObject({ type: 'replaced' })
		expect(await secondRuntime.nextMessage()).toMatchObject({ type: 'registered' })
		expect(errorCode(await replacedCall)).toBe('replaced')
		await firstRuntime.waitForClose()

		const disconnectedCall = bridge.request('disconnect')
		await secondRuntime.nextMessage()
		const disconnected = secondRuntime.waitForClose()
		secondRuntime.socket.close()
		await disconnected
		expect(errorCode(await disconnectedCall)).toBe('unavailable')

		const thirdRuntime = await FakeRuntime.connect(canvasUrl)
		expect(await thirdRuntime.nextMessage()).toMatchObject({ type: 'registered' })
		const timedOutCall = bridge.request('timeout')
		const timedOutRequest = await thirdRuntime.nextMessage()
		expect(errorCode(await timedOutCall)).toBe('timeout')
		thirdRuntime.sendResponse(bridgeRequestId(timedOutRequest), { late: true })

		const afterTimeoutCall = bridge.request('after-timeout')
		const afterTimeoutRequest = await thirdRuntime.nextMessage()
		thirdRuntime.sendResponse(bridgeRequestId(afterTimeoutRequest), { revision: 2 })
		expect((await afterTimeoutCall).result).toMatchObject({ structuredContent: { revision: 2 } })

		const outOfOrderCall = bridge.request('out-of-order')
		await thirdRuntime.nextMessage()
		thirdRuntime.sendResponse('wrong-request-id', {})
		await thirdRuntime.waitForClose()
		expect(errorCode(await outOfOrderCall)).toBe('unavailable')
	} finally {
		await bridge.stop()
	}
})

test('defaults the generated Canvas URL to the Vite development server', async () => {
	const env = { ...process.env }
	delete env.CANVAS_URL
	const cli = spawn(process.execPath, [resolve('cli/canvas-mcp.mjs')], {
		stdio: ['pipe', 'pipe', 'pipe'],
		env,
	})
	let stderr = ''
	cli.stderr.setEncoding('utf8')
	cli.stderr.on('data', (chunk) => {
		stderr += chunk
	})
	try {
		await expect.poll(() => stderr.match(/Canvas Runtime URL: (.+)/)?.[1]).toBeTruthy()
		expect(stderr).toContain('Canvas Runtime URL: http://127.0.0.1:5173/')
	} finally {
		if (cli.exitCode === null) {
			const exit = once(cli, 'exit')
			cli.kill()
			await exit
		}
	}
})

#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'

const bridgeVersion = 1
const requestTimeoutMs =
	process.env.NODE_ENV === 'test' && process.env.CANVAS_BRIDGE_TEST_TIMEOUT_MS
		? Number(process.env.CANVAS_BRIDGE_TEST_TIMEOUT_MS)
		: 30_000
const token = randomBytes(32).toString('base64url')
const canvasUrlBase = process.env.CANVAS_URL ?? 'http://127.0.0.1:5173/'
let activeRuntime = null
let pendingRequest = null
let nextRequestId = 1
const ignoredResponseIds = new Set()

const server = createServer()
server.on('upgrade', (request, socket) => {
	if (request.headers.upgrade?.toLowerCase() !== 'websocket') return socket.destroy()
	const key = request.headers['sec-websocket-key']
	if (typeof key !== 'string') return socket.destroy()

	const accept = createHash('sha1')
		.update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
		.digest('base64')
	socket.write(
		'HTTP/1.1 101 Switching Protocols\r\n' +
			'Upgrade: websocket\r\n' +
			'Connection: Upgrade\r\n' +
			`Sec-WebSocket-Accept: ${accept}\r\n\r\n`
	)
	const runtime = createRuntimeConnection(socket)
	socket.on('data', (chunk) => runtime.read(chunk))
	socket.on('close', () => disconnectRuntime(runtime))
	socket.on('error', () => disconnectRuntime(runtime))
})

server.listen({ host: '127.0.0.1', port: 0 }, () => {
	const address = server.address()
	if (!address || typeof address === 'string') throw new Error('Bridge did not bind a TCP port')
	const canvasUrl = new URL(canvasUrlBase)
	canvasUrl.hash = new URLSearchParams({
		'canvas-bridge-port': String(address.port),
		'canvas-bridge-token': token,
	}).toString()
	process.stderr.write(`Canvas Runtime URL: ${canvasUrl}\n`)
	process.stderr.write(`Canvas MCP bridge listening on 127.0.0.1:${address.port}\n`)
})

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
	let request
	try {
		request = JSON.parse(line)
	} catch {
		return writeMcpError(null, -32700, 'Parse error')
	}
	void handleMcpRequest(request)
})

async function handleMcpRequest(request) {
	if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
		return writeMcpError(request?.id ?? null, -32600, 'Invalid Request')
	}
	if (!('id' in request)) return
	if (request.method === 'initialize') {
		return writeMcpResult(request.id, {
			protocolVersion: request.params?.protocolVersion ?? '2025-03-26',
			capabilities: { tools: {} },
			serverInfo: { name: 'canvas-runtime', version: '1.0.0' },
		})
	}
	if (request.method === 'tools/list') {
		return writeMcpResult(request.id, {
			tools: [
				{
					name: 'canvas.get_context',
					description: 'Get the canonical context of the active Canvas Runtime.',
					inputSchema: { type: 'object', additionalProperties: false, properties: {} },
				},
				{
					name: 'canvas.apply_actions',
					description: 'Atomically apply revision-safe Canvas Item actions.',
					inputSchema: {
						type: 'object',
						required: ['expectedRevision', 'actions'],
						additionalProperties: false,
						properties: { expectedRevision: { type: 'integer', minimum: 0 }, actions: { type: 'array', minItems: 1 } },
					},
				},
				{
					name: 'canvas.capture',
					description: 'Capture a transparent PNG of Canvas Runtime diagram content.',
					inputSchema: {
						type: 'object',
						additionalProperties: false,
						properties: {
							expectedRevision: { type: 'integer', minimum: 0 },
							rect: {
								type: 'object',
								additionalProperties: false,
								required: ['x', 'y', 'w', 'h'],
								properties: {
									x: { type: 'number' },
									y: { type: 'number' },
									w: { type: 'number', exclusiveMinimum: 0 },
									h: { type: 'number', exclusiveMinimum: 0 },
								},
							},
						},
					},
				},
			],
		})
	}
	if (request.method !== 'tools/call') return writeMcpError(request.id, -32601, 'Method not found')
	const input = request.params?.arguments ?? {}
	const tool = request.params?.name
	if (tool === 'canvas.get_context' && (!isRecord(input) || Object.keys(input).length !== 0)) {
		return writeMcpResult(request.id, toolError('validation', 'canvas.get_context does not accept arguments'))
	}
	if (tool === 'canvas.apply_actions' && !isApplyActionsInput(input)) {
		return writeMcpResult(request.id, toolError('validation', 'canvas.apply_actions requires a non-negative revision and actions'))
	}
	if (tool === 'canvas.capture' && !isCaptureInput(input)) {
		return writeMcpResult(request.id, toolError('validation', 'canvas.capture requires an object input'))
	}
	if (tool !== 'canvas.get_context' && tool !== 'canvas.apply_actions' && tool !== 'canvas.capture') {
		return writeMcpResult(request.id, toolError('validation', 'Unknown Canvas Runtime tool'))
	}
	if (!activeRuntime?.registered) return writeMcpResult(request.id, toolError('unavailable'))
	if (pendingRequest) return writeMcpResult(request.id, toolError('busy'))

	const bridgeRequestId = `bridge-${nextRequestId++}`
	const runtime = activeRuntime
	const timeout = setTimeout(() => {
		if (pendingRequest?.bridgeRequestId !== bridgeRequestId) return
		ignoredResponseIds.add(bridgeRequestId)
		if (ignoredResponseIds.size > 100) ignoredResponseIds.delete(ignoredResponseIds.values().next().value)
		pendingRequest = null
		writeMcpResult(request.id, toolError('timeout'))
	}, requestTimeoutMs)
	pendingRequest = { bridgeRequestId, mcpRequestId: request.id, runtime, timeout }
	runtime.send({
		version: bridgeVersion,
		type: 'request',
		request: { version: bridgeVersion, id: bridgeRequestId, tool, input },
	})
}

function createRuntimeConnection(socket) {
	let buffer = Buffer.alloc(0)
	let fragments = []
	let closed = false
	const runtime = {
		registered: false,
		send(message) {
			if (!closed) socket.write(encodeWebSocketFrame(0x1, Buffer.from(JSON.stringify(message))))
		},
		close() {
			if (closed) return
			closed = true
			socket.end(encodeWebSocketFrame(0x8, Buffer.alloc(0)))
		},
		read(chunk) {
			if (closed) return
			buffer = Buffer.concat([buffer, chunk])
			while (buffer.length >= 2) {
				const firstByte = buffer[0]
				const secondByte = buffer[1]
				const isFinal = (firstByte & 0x80) !== 0
				const opcode = firstByte & 0x0f
				const encodedLength = secondByte & 0x7f
				if ((firstByte & 0x70) !== 0 || (secondByte & 0x80) === 0) return runtime.close()
				const lengthBytes = encodedLength === 126 ? 2 : encodedLength === 127 ? 8 : 0
				if (buffer.length < 2 + lengthBytes + 4) return
				let payloadLength
				if (encodedLength === 126) payloadLength = buffer.readUInt16BE(2)
				else if (encodedLength === 127) {
					const length = buffer.readBigUInt64BE(2)
					if (length > BigInt(Number.MAX_SAFE_INTEGER)) return runtime.close()
					payloadLength = Number(length)
				} else payloadLength = encodedLength
				if (opcode >= 0x8 && (!isFinal || payloadLength > 125)) return runtime.close()
				const maskOffset = 2 + lengthBytes
				const payloadOffset = maskOffset + 4
				if (buffer.length < payloadOffset + payloadLength) return
				const mask = buffer.subarray(maskOffset, payloadOffset)
				const payload = Buffer.from(buffer.subarray(payloadOffset, payloadOffset + payloadLength))
				buffer = buffer.subarray(payloadOffset + payloadLength)
				for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4]

				if (opcode === 0x8) return runtime.close()
				if (opcode === 0x9) {
					socket.write(encodeWebSocketFrame(0xa, payload))
					continue
				}
				if (opcode === 0x1) {
					if (fragments.length) return runtime.close()
					if (isFinal) handleRuntimeMessage(runtime, payload.toString())
					else fragments = [payload]
					continue
				}
				if (opcode === 0x0 && fragments.length) {
					fragments.push(payload)
					if (isFinal) {
						handleRuntimeMessage(runtime, Buffer.concat(fragments).toString())
						fragments = []
					}
					continue
				}
				return runtime.close()
			}
		},
	}
	return runtime
}

function encodeWebSocketFrame(opcode, content) {
	if (content.length < 126) return Buffer.concat([Buffer.from([0x80 | opcode, content.length]), content])
	if (content.length <= 0xffff) {
		const header = Buffer.alloc(4)
		header[0] = 0x80 | opcode
		header[1] = 126
		header.writeUInt16BE(content.length, 2)
		return Buffer.concat([header, content])
	}
	const header = Buffer.alloc(10)
	header[0] = 0x80 | opcode
	header[1] = 127
	header.writeBigUInt64BE(BigInt(content.length), 2)
	return Buffer.concat([header, content])
}

function handleRuntimeMessage(runtime, payload) {
	let message
	try {
		message = JSON.parse(payload)
	} catch {
		return runtime.close()
	}
	if (!runtime.registered) {
		if (message?.version !== bridgeVersion || message?.type !== 'register' || message?.token !== token) {
			return runtime.close()
		}
		if (activeRuntime && activeRuntime !== runtime) {
			settlePending(activeRuntime, 'replaced')
			activeRuntime.send({ version: bridgeVersion, type: 'replaced' })
			activeRuntime.close()
		}
		runtime.registered = true
		activeRuntime = runtime
		return runtime.send({ version: bridgeVersion, type: 'registered' })
	}
	if (message?.version !== bridgeVersion || message?.type !== 'response' || !isRuntimeResponse(message.response)) {
		return runtime.close()
	}
	if (ignoredResponseIds.delete(message.response.id)) return
	if (
		!pendingRequest ||
		pendingRequest.runtime !== runtime ||
		pendingRequest.bridgeRequestId !== message.response.id
	) {
		return runtime.close()
	}
	const { mcpRequestId, timeout } = pendingRequest
	clearTimeout(timeout)
	pendingRequest = null
	if (message.response.ok) {
		writeMcpResult(mcpRequestId, mcpSuccessResult(message.response))
	} else {
		writeMcpResult(mcpRequestId, toolError(message.response.error?.code ?? 'unavailable', undefined, message.response.error))
	}
}

function mcpSuccessResult(response) {
	if (response.tool === 'canvas.capture') {
		const { revision, rect, content } = response.result
		return {
			content: [
				{ type: 'image', mimeType: content.mimeType, data: content.data },
				{ type: 'text', text: JSON.stringify({ revision, rect }) },
			],
			structuredContent: { revision, rect },
		}
	}
	return {
		content: [{ type: 'text', text: JSON.stringify(response.result) }],
		structuredContent: response.result,
	}
}

function isRuntimeResponse(response) {
	if (
		!isRecord(response) ||
		response.version !== bridgeVersion ||
		typeof response.id !== 'string' ||
		(response.tool !== 'canvas.get_context' &&
			response.tool !== 'canvas.apply_actions' &&
			response.tool !== 'canvas.capture') ||
		typeof response.ok !== 'boolean'
	) {
		return false
	}
	return response.ok ? isRecord(response.result) : isRecord(response.error) && typeof response.error.code === 'string'
}

function isRecord(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isApplyActionsInput(input) {
	return (
		isRecord(input) &&
		Number.isInteger(input.expectedRevision) &&
		input.expectedRevision >= 0 &&
		Array.isArray(input.actions) &&
		input.actions.length > 0
	)
}

function isCaptureInput(input) {
	return isRecord(input)
}

function settlePending(runtime, code) {
	if (!pendingRequest || pendingRequest.runtime !== runtime) return
	const { mcpRequestId, timeout } = pendingRequest
	clearTimeout(timeout)
	pendingRequest = null
	writeMcpResult(mcpRequestId, toolError(code))
}

function disconnectRuntime(runtime) {
	if (activeRuntime !== runtime) return
	activeRuntime = null
	settlePending(runtime, 'unavailable')
}

function toolError(code, message = code, error = { code }) {
	return { content: [{ type: 'text', text: message }], isError: true, structuredContent: { error } }
}

function writeMcpResult(id, result) {
	process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}

function writeMcpError(id, code, message) {
	process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`)
}

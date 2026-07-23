#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'

const bridgeVersion = 1
const token = randomBytes(32).toString('base64url')
const canvasUrlBase = process.env.CANVAS_URL ?? 'http://127.0.0.1:4173/'
let activeRuntime = null
let nextRequestId = 1
const pendingRequests = new Map()

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
	if (!request || request.jsonrpc !== '2.0' || !('id' in request) || typeof request.method !== 'string') {
		return writeMcpError(request?.id ?? null, -32600, 'Invalid Request')
	}
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
			],
		})
	}
	if (request.method !== 'tools/call') return writeMcpError(request.id, -32601, 'Method not found')
	if (request.params?.name !== 'canvas.get_context') {
		return writeMcpResult(request.id, toolError('validation', 'Unknown Canvas Runtime tool'))
	}
	if (!activeRuntime?.registered) return writeMcpResult(request.id, toolError('unavailable'))

	const bridgeRequestId = `bridge-${nextRequestId++}`
	pendingRequests.set(bridgeRequestId, request.id)
	activeRuntime.send({
		version: bridgeVersion,
		type: 'request',
		request: {
			version: bridgeVersion,
			id: bridgeRequestId,
			tool: 'canvas.get_context',
			input: request.params.arguments ?? {},
		},
	})
}

function createRuntimeConnection(socket) {
	let buffer = Buffer.alloc(0)
	const runtime = {
		registered: false,
		send(message) {
			const content = Buffer.from(JSON.stringify(message))
			const header = content.length < 126 ? Buffer.from([0x81, content.length]) : Buffer.from([0x81, 126, content.length >> 8, content.length & 0xff])
			socket.write(Buffer.concat([header, content]))
		},
		close() {
			socket.end(Buffer.from([0x88, 0x00]))
		},
		read(chunk) {
			buffer = Buffer.concat([buffer, chunk])
			while (buffer.length >= 2) {
				const encodedLength = buffer[1] & 0x7f
				if ((buffer[1] & 0x80) === 0 || encodedLength === 127) return runtime.close()
				const lengthBytes = encodedLength === 126 ? 2 : 0
				if (buffer.length < 6 + lengthBytes) return
				const payloadLength = lengthBytes ? buffer.readUInt16BE(2) : encodedLength
				const maskOffset = 2 + lengthBytes
				if (buffer.length < maskOffset + 4 + payloadLength) return
				const opcode = buffer[0] & 0x0f
				const mask = buffer.subarray(maskOffset, maskOffset + 4)
				const payload = buffer.subarray(maskOffset + 4, maskOffset + 4 + payloadLength)
				buffer = buffer.subarray(maskOffset + 4 + payloadLength)
				if (opcode === 0x8) return runtime.close()
				if (opcode !== 0x1) continue
				for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4]
				handleRuntimeMessage(runtime, payload.toString())
			}
		},
	}
	return runtime
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
		if (activeRuntime && activeRuntime !== runtime) activeRuntime.close()
		runtime.registered = true
		activeRuntime = runtime
		return runtime.send({ version: bridgeVersion, type: 'registered' })
	}
	if (message?.version !== bridgeVersion || message?.type !== 'response') return runtime.close()
	const mcpRequestId = pendingRequests.get(message.response?.id)
	if (mcpRequestId === undefined) return
	pendingRequests.delete(message.response.id)
	if (message.response.ok) {
		writeMcpResult(mcpRequestId, {
			content: [{ type: 'text', text: JSON.stringify(message.response.result) }],
			structuredContent: message.response.result,
		})
	} else {
		writeMcpResult(mcpRequestId, toolError(message.response.error?.code ?? 'unavailable'))
	}
}

function disconnectRuntime(runtime) {
	if (activeRuntime !== runtime) return
	activeRuntime = null
	for (const [bridgeRequestId, mcpRequestId] of pendingRequests) {
		pendingRequests.delete(bridgeRequestId)
		writeMcpResult(mcpRequestId, toolError('unavailable'))
	}
}

function toolError(code, message = code) {
	return { content: [{ type: 'text', text: message }], isError: true, structuredContent: { error: { code } } }
}

function writeMcpResult(id, result) {
	process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}

function writeMcpError(id, code, message) {
	process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`)
}

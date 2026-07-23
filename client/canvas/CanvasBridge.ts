import { CanvasToolRequest, CanvasToolRequestSchema, CanvasToolResponse } from '../../shared/canvas-contract'

export type CanvasBridgeStatus = 'connected' | 'reconnecting' | 'disconnected'

type CanvasToolHandler = (request: CanvasToolRequest) => CanvasToolResponse

const BRIDGE_VERSION = 1
const RECONNECT_DELAYS_MS = [250, 500, 1_000]

export class CanvasBridge {
	private socket: WebSocket | undefined
	private reconnectAttempt = 0
	private disposed = false

	private constructor(
		private readonly endpoint: string,
		private readonly token: string,
		private readonly handleTool: CanvasToolHandler,
		private readonly setStatus: (status: CanvasBridgeStatus) => void
	) {}

	static connectFromLocation(
		location: Location,
		handleTool: CanvasToolHandler,
		setStatus: (status: CanvasBridgeStatus) => void
	) {
		const connection = new URLSearchParams(location.hash.slice(1))
		const port = connection.get('canvas-bridge-port')
		const token = connection.get('canvas-bridge-token')
		if (!port || !token || !/^\d+$/.test(port)) {
			setStatus('disconnected')
			return undefined
		}

		const bridge = new CanvasBridge(`ws://127.0.0.1:${port}`, token, handleTool, setStatus)
		bridge.connect()
		return bridge
	}

	dispose() {
		this.disposed = true
		this.socket?.close()
	}

	private connect() {
		if (this.disposed) return
		this.socket = new WebSocket(this.endpoint)
		this.socket.addEventListener('open', () => {
			this.socket?.send(JSON.stringify({ version: BRIDGE_VERSION, type: 'register', token: this.token }))
		})
		this.socket.addEventListener('message', (event) => this.handleMessage(event.data))
		this.socket.addEventListener('close', () => this.reconnect())
		this.socket.addEventListener('error', () => this.socket?.close())
	}

	private handleMessage(data: unknown) {
		if (typeof data !== 'string') return this.socket?.close()
		let message: unknown
		try {
			message = JSON.parse(data)
		} catch {
			return this.socket?.close()
		}
		if (!isRecord(message) || message.version !== BRIDGE_VERSION || typeof message.type !== 'string') {
			return this.socket?.close()
		}
		if (message.type === 'registered') {
			this.reconnectAttempt = 0
			window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
			this.setStatus('connected')
			return
		}
		if (message.type !== 'request') return this.socket?.close()

		const parsedRequest = CanvasToolRequestSchema.safeParse(message.request)
		if (!parsedRequest.success) return this.socket?.close()
		const response = this.handleTool(parsedRequest.data)
		this.socket?.send(JSON.stringify({ version: BRIDGE_VERSION, type: 'response', response }))
	}

	private reconnect() {
		if (this.disposed) return
		const delay = RECONNECT_DELAYS_MS[this.reconnectAttempt++]
		if (delay === undefined) {
			this.setStatus('disconnected')
			return
		}
		this.setStatus('reconnecting')
		window.setTimeout(() => this.connect(), delay)
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null
}

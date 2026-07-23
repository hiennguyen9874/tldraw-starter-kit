import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
	browserLaunchCommand,
	createCanvasRuntimeBrowserOpener,
	openCanvasRuntime,
} from './open-canvas-runtime.mjs'

const runtimeUrl = 'http://127.0.0.1:5173/#canvas-bridge-port=123&canvas-bridge-token=secret'

describe('Canvas Runtime browser opener', () => {
	it('opens once after initialization and URL readiness in either order', () => {
		for (const order of ['initialize-first', 'url-first']) {
			const openRuntime = vi.fn()
			const opener = createCanvasRuntimeBrowserOpener({ enabled: true, openRuntime, onFailure: vi.fn() })
			if (order === 'initialize-first') {
				opener.mcpInitialized()
				opener.runtimeUrlReady(runtimeUrl)
			} else {
				opener.runtimeUrlReady(runtimeUrl)
				opener.mcpInitialized()
			}
			opener.mcpInitialized()
			opener.runtimeUrlReady(runtimeUrl)
			expect(openRuntime).toHaveBeenCalledOnce()
			expect(openRuntime).toHaveBeenCalledWith(runtimeUrl, { onFailure: expect.any(Function) })
		}
	})

	it('does not open when disabled', () => {
		const openRuntime = vi.fn()
		const opener = createCanvasRuntimeBrowserOpener({ enabled: false, openRuntime, onFailure: vi.fn() })
		opener.mcpInitialized()
		opener.runtimeUrlReady(runtimeUrl)
		expect(openRuntime).not.toHaveBeenCalled()
	})

	it('uses each platform default browser command without a shell', () => {
		expect(browserLaunchCommand(runtimeUrl, 'linux')).toEqual({ command: 'xdg-open', args: [runtimeUrl] })
		expect(browserLaunchCommand(runtimeUrl, 'darwin')).toEqual({ command: 'open', args: [runtimeUrl] })
		expect(browserLaunchCommand(runtimeUrl, 'win32', 'custom-cmd.exe')).toEqual({
			command: 'custom-cmd.exe',
			args: ['/d', '/s', '/c', 'start', '""', `"${runtimeUrl}"`],
		})
	})

	it('reports launch failure without including the credentialed URL', () => {
		const child = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn> }
		child.unref = vi.fn()
		const spawnProcess = vi.fn(() => child)
		const onFailure = vi.fn()
		openCanvasRuntime(runtimeUrl, { platform: 'linux', spawnProcess, onFailure })
		child.emit('error', Object.assign(new Error('failed'), { code: 'ENOENT' }))
		expect(onFailure).toHaveBeenCalledWith('browser command could not be started (ENOENT)')
		expect(onFailure.mock.calls[0][0]).not.toContain(runtimeUrl)
		expect(child.unref).toHaveBeenCalledOnce()
	})
})

import { spawn } from 'node:child_process'

export function createCanvasRuntimeBrowserOpener({ enabled, openRuntime = openCanvasRuntime, onFailure }) {
	let initialized = false
	let runtimeUrl = null
	let attempted = false

	function openWhenReady() {
		if (!enabled || !initialized || !runtimeUrl || attempted) return
		attempted = true
		openRuntime(runtimeUrl, { onFailure })
	}

	return {
		mcpInitialized() {
			initialized = true
			openWhenReady()
		},
		runtimeUrlReady(url) {
			runtimeUrl = url
			openWhenReady()
		},
	}
}

export function openCanvasRuntime(
	url,
	{
		platform = process.platform,
		spawnProcess = spawn,
		windowsCommand = process.env.ComSpec ?? 'cmd.exe',
		onFailure = () => {},
	} = {}
) {
	const launch = browserLaunchCommand(url, platform, windowsCommand)
	if (!launch) {
		onFailure(`unsupported platform: ${platform}`)
		return
	}

	let settled = false
	let child
	try {
		child = spawnProcess(launch.command, launch.args, {
			detached: true,
			stdio: 'ignore',
			windowsHide: true,
			windowsVerbatimArguments: platform === 'win32',
		})
	} catch {
		onFailure('browser command could not be started')
		return
	}
	child.once('error', (error) => {
		if (settled) return
		settled = true
		onFailure(`browser command could not be started${error?.code ? ` (${error.code})` : ''}`)
	})
	child.once('exit', (code, signal) => {
		if (settled) return
		settled = true
		if (code !== 0) onFailure(`browser command exited with ${signal ? `signal ${signal}` : `code ${code}`}`)
	})
	child.unref()
}

export function browserLaunchCommand(url, platform, windowsCommand = 'cmd.exe') {
	if (platform === 'darwin') return { command: 'open', args: [url] }
	if (platform === 'win32') {
		return { command: windowsCommand, args: ['/d', '/s', '/c', 'start', '""', `"${url}"`] }
	}
	if (platform === 'linux') return { command: 'xdg-open', args: [url] }
	return null
}

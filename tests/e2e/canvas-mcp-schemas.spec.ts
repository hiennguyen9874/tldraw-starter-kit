import { expect, test } from '@playwright/test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { resolve } from 'node:path'
import {
	CanvasToolInputSchemas,
	toCanvasToolInputJsonSchema,
	type CanvasToolName,
} from '../../shared/canvas-contract'

const validInputs = {
	'canvas.get_context': {},
	'canvas.apply_actions': {
		expectedRevision: 0,
		actions: [
			{ type: 'create', item: { id: 'label', type: 'text', x: 0, y: 0, text: 'Label' } },
			{ type: 'create', item: { id: 'node', type: 'geo', geo: 'rectangle', x: 0, y: 0, w: 100, h: 80 } },
			{ type: 'create', item: { id: 'other', type: 'geo', geo: 'ellipse', x: 200, y: 0, w: 100, h: 80 } },
			{ type: 'create', item: { id: 'edge', type: 'arrow', fromId: 'node', toId: 'other' } },
			{ type: 'create', item: { id: 'group', type: 'frame', x: 0, y: 0, w: 400, h: 200, memberIds: ['label', 'node'] } },
			{ type: 'update', id: 'label', patch: { type: 'text', text: 'Updated' } },
			{ type: 'update', id: 'node', patch: { type: 'geo', w: 120 } },
			{ type: 'update', id: 'edge', patch: { type: 'arrow', fromId: 'other' } },
			{ type: 'update', id: 'group', patch: { type: 'frame', memberIds: ['label'] } },
			{ type: 'delete', id: 'label' },
			{ type: 'layout', direction: 'left-to-right', scope: { type: 'all' } },
			{ type: 'layout', direction: 'top-to-bottom', scope: { type: 'frame', frameId: 'group' } },
			{ type: 'layout', direction: 'left-to-right', scope: { type: 'items', itemIds: ['node', 'other'] } },
		],
	},
	'canvas.capture': { expectedRevision: 1, rect: { x: 0, y: 0, w: 100, h: 80 } },
	'canvas.export': { format: 'svg', expectedRevision: 1, rect: { x: 0, y: 0, w: 100, h: 80 } },
} satisfies Record<CanvasToolName, object>

const invalidInputs = {
	'canvas.get_context': [{ unexpected: true }],
	'canvas.apply_actions': [
		{ expectedRevision: -1, actions: [{ type: 'delete', id: 'node' }] },
		{ expectedRevision: Number.MAX_SAFE_INTEGER + 1, actions: [{ type: 'delete', id: 'node' }] },
		{ expectedRevision: 0, actions: [{ type: 'create', item: { id: '', type: 'geo', geo: 'star', x: 0, y: 0, w: 0, h: -1 } }] },
		{ expectedRevision: 0, actions: [{ type: 'update', id: 'node', patch: { type: 'geo' } }] },
		{ expectedRevision: 0, actions: [{ type: 'layout', direction: 'left-to-right', scope: { type: 'items', itemIds: [] } }] },
	],
	'canvas.capture': [{ expectedRevision: -1 }, { rect: { x: 0, y: 0, w: 0, h: 80 } }],
	'canvas.export': [{ format: 'pdf' }, { format: 'png', expectedRevision: -1 }],
} satisfies Record<CanvasToolName, object[]>

test('discovers MCP schemas that agree with canonical Canvas Tool input validation', async () => {
	const cli = spawn(process.execPath, [resolve('cli/canvas-mcp.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] })
	let output = ''
	cli.stdout.setEncoding('utf8')
	cli.stdout.on('data', (chunk) => {
		output += chunk
	})

	try {
		cli.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'tools', method: 'tools/list' })}\n`)
		await expect.poll(() => output).toContain('"id":"tools"')
		const response = JSON.parse(output) as { result: { tools: Array<{ name: CanvasToolName; inputSchema: JsonSchema }> } }
		const tools = new Map(response.result.tools.map((tool) => [tool.name, tool.inputSchema]))

		expect([...tools.keys()]).toEqual(Object.keys(CanvasToolInputSchemas))
		for (const name of Object.keys(CanvasToolInputSchemas) as CanvasToolName[]) {
			const runtimeSchema = CanvasToolInputSchemas[name]
			const discoverySchema = tools.get(name)
			if (!discoverySchema) throw new Error(`Missing schema for ${name}`)

			expect(discoverySchema).toEqual(toCanvasToolInputJsonSchema(runtimeSchema))
			expect(matchesJsonSchema(discoverySchema, validInputs[name])).toBe(runtimeSchema.safeParse(validInputs[name]).success)
			for (const input of invalidInputs[name]) {
				expect(matchesJsonSchema(discoverySchema, input)).toBe(runtimeSchema.safeParse(input).success)
			}
		}
	} finally {
		if (cli.exitCode === null) {
			const exit = once(cli, 'exit')
			cli.kill()
			await exit
		}
	}
})

type JsonSchema = {
	type?: string
	properties?: Record<string, JsonSchema>
	required?: string[]
	additionalProperties?: boolean
	oneOf?: JsonSchema[]
	anyOf?: JsonSchema[]
	const?: unknown
	enum?: unknown[]
	minimum?: number
	maximum?: number
	exclusiveMinimum?: number
	minLength?: number
	minItems?: number
	items?: JsonSchema
}

function matchesJsonSchema(schema: JsonSchema, value: unknown): boolean {
	if (schema.oneOf && schema.oneOf.filter((option) => matchesJsonSchema(option, value)).length !== 1) return false
	if (schema.anyOf && !schema.anyOf.some((option) => matchesJsonSchema(option, value))) return false
	if (schema.const !== undefined && value !== schema.const) return false
	if (schema.enum && !schema.enum.includes(value)) return false
	if (schema.type === 'object') {
		if (!isRecord(value)) return false
		if (schema.required?.some((key) => !(key in value))) return false
		if (schema.additionalProperties === false && Object.keys(value).some((key) => !schema.properties?.[key])) return false
		if (schema.properties && Object.entries(schema.properties).some(([key, property]) => key in value && !matchesJsonSchema(property, value[key]))) return false
	}
	if (schema.type === 'array') {
		if (!Array.isArray(value)) return false
		if (schema.minItems !== undefined && value.length < schema.minItems) return false
		if (schema.items && value.some((item) => !matchesJsonSchema(schema.items!, item))) return false
	}
	if (schema.type === 'string' && (typeof value !== 'string' || (schema.minLength !== undefined && value.length < schema.minLength))) return false
	if (schema.type === 'number' && typeof value !== 'number') return false
	if (schema.type === 'integer' && !Number.isInteger(value)) return false
	if (
		typeof value === 'number' &&
		((schema.minimum !== undefined && value < schema.minimum) ||
			(schema.maximum !== undefined && value > schema.maximum) ||
			(schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum))
	)
		return false
	return true
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

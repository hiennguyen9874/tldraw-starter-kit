import { describe, expect, it } from 'vitest'
import {
	CanvasDocumentSchema,
	CanvasItemPatchSchema,
	CanvasItemSchema,
	CanvasToolRequestSchema,
	CanvasToolResponseSchema,
} from './canvas-contract'

describe('Canvas Item contract', () => {
	it('canonicalizes equivalent documents by public ID', () => {
		const document = CanvasDocumentSchema.parse({
			items: [
				{
					id: 'z-arrow',
					type: 'arrow',
					fromId: 'node-b',
					toId: 'node-a',
				},
				{
					id: 'node-b',
					type: 'geo',
					geo: 'ellipse',
					x: 200,
					y: 100,
					w: 120,
					h: 80,
					text: 'B',
				},
				{
					id: 'group',
					type: 'frame',
					x: 0,
					y: 0,
					w: 400,
					h: 300,
					memberIds: ['label', 'node-b', 'node-a'],
				},
				{ id: 'label', type: 'text', x: 50, y: 50, text: 'Diagram' },
				{
					id: 'node-a',
					type: 'geo',
					geo: 'rectangle',
					x: 0,
					y: 100,
					w: 120,
					h: 80,
					text: 'A',
				},
			],
		})

		expect(document.items.map((item) => item.id)).toEqual([
			'group',
			'label',
			'node-a',
			'node-b',
			'z-arrow',
		])
	})

	it('uses locale-independent lexical Canvas Item ID ordering', () => {
		const document = CanvasDocumentSchema.parse({
			items: [
				{ id: 'a', type: 'text', x: 0, y: 0, text: 'lowercase' },
				{ id: 'Z', type: 'text', x: 0, y: 0, text: 'uppercase' },
			],
		})

		expect(document.items.map((item) => item.id)).toEqual(['Z', 'a'])
	})

	it('rejects native records and invalid Bound Arrows', () => {
		expect(() =>
			CanvasDocumentSchema.parse({
				items: [
					{
						id: 'node',
						type: 'geo',
						geo: 'rectangle',
						x: 0,
						y: 0,
						w: 100,
						h: 100,
						recordType: 'shape',
					},
				],
			})
		).toThrow()

		expect(() =>
			CanvasItemSchema.parse({ id: 'loop', type: 'arrow', fromId: 'node', toId: 'node' })
		).toThrow()

		expect(() =>
			CanvasItemPatchSchema.parse({ type: 'arrow', fromId: 'node', toId: 'node' })
		).toThrow()
	})

	it('rejects Bound Arrows and frames that violate Canvas Item topology', () => {
		expect(() =>
			CanvasDocumentSchema.parse({
				items: [
					{ id: 'label', type: 'text', x: 0, y: 0, text: 'Not a node' },
					{ id: 'node', type: 'geo', geo: 'rectangle', x: 0, y: 0, w: 100, h: 100 },
					{ id: 'edge', type: 'arrow', fromId: 'label', toId: 'node' },
				],
			})
		).toThrow()

		expect(() =>
			CanvasDocumentSchema.parse({
				items: [
					{ id: 'node', type: 'geo', geo: 'rectangle', x: 0, y: 0, w: 100, h: 100 },
					{ id: 'inner', type: 'frame', x: 0, y: 0, w: 100, h: 100, memberIds: [] },
					{ id: 'outer', type: 'frame', x: 0, y: 0, w: 100, h: 100, memberIds: ['inner', 'node'] },
				],
			})
		).toThrow()

		expect(() =>
			CanvasDocumentSchema.parse({
				items: [
					{ id: 'node', type: 'geo', geo: 'rectangle', x: 0, y: 0, w: 100, h: 100 },
					{ id: 'frame-a', type: 'frame', x: 0, y: 0, w: 100, h: 100, memberIds: ['node'] },
					{ id: 'frame-b', type: 'frame', x: 200, y: 0, w: 100, h: 100, memberIds: ['node'] },
				],
			})
		).toThrow()
	})

	it('validates revisioned tool requests and structured stale-revision errors', () => {
		expect(
			CanvasToolRequestSchema.parse({
				version: 1,
				id: 'request-1',
				tool: 'canvas.apply_actions',
				input: {
					expectedRevision: 4,
					actions: [
						{
							type: 'create',
							item: {
								id: 'node',
								type: 'geo',
								geo: 'rectangle',
								x: 0,
								y: 0,
								w: 100,
								h: 100,
							},
						},
					],
				},
			})
		).toMatchObject({ tool: 'canvas.apply_actions' })

		expect(
			CanvasToolResponseSchema.parse({
				version: 1,
				id: 'request-1',
				ok: false,
				tool: 'canvas.apply_actions',
				error: {
					code: 'stale_revision',
					expectedRevision: 4,
					currentRevision: 5,
				},
			})
		).toMatchObject({ error: { code: 'stale_revision', currentRevision: 5 } })
	})
})

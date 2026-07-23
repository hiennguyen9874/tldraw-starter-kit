import { expect, test } from 'vitest'
import { CanvasDocumentSchema } from './canvas-contract'
import { proposeCanvasActions } from '../client/canvas/proposeCanvasActions'

test('deleting a geometric Canvas Item removes its Bound Arrows and detaches it from its frame', () => {
	const result = proposeCanvasActions(
		CanvasDocumentSchema.parse({
			items: [
				{ id: 'frame', type: 'frame', x: 0, y: 0, w: 300, h: 200, memberIds: ['node'] },
				{ id: 'edge', type: 'arrow', fromId: 'node', toId: 'other' },
				{ id: 'node', type: 'geo', geo: 'rectangle', x: 0, y: 0, w: 100, h: 80 },
				{ id: 'other', type: 'geo', geo: 'ellipse', x: 200, y: 0, w: 100, h: 80 },
			],
		}),
		[{ type: 'delete', id: 'node' }]
	)

	expect(result).toEqual({
		document: {
			items: [
				{ id: 'frame', type: 'frame', x: 0, y: 0, w: 300, h: 200, memberIds: [] },
				{ id: 'other', type: 'geo', geo: 'ellipse', x: 200, y: 0, w: 100, h: 80, text: '' },
			],
		},
		changedIds: ['frame'],
		deletedIds: ['node', 'edge'],
	})
})

test('deleting a frame detaches its members without deleting them', () => {
	const result = proposeCanvasActions(
		CanvasDocumentSchema.parse({
			items: [
				{ id: 'frame', type: 'frame', x: 0, y: 0, w: 300, h: 200, memberIds: ['node'] },
				{ id: 'node', type: 'geo', geo: 'rectangle', x: 0, y: 0, w: 100, h: 80 },
			],
		}),
		[{ type: 'delete', id: 'frame' }]
	)

	expect(result).toEqual({
		document: {
			items: [
				{ id: 'node', type: 'geo', geo: 'rectangle', x: 0, y: 0, w: 100, h: 80, text: '' },
			],
		},
		changedIds: [],
		deletedIds: ['frame'],
	})
})

test('attributes invalid fields to the action that supplied them', () => {
	const result = proposeCanvasActions(
		{ items: [] },
		[
			{
				type: 'create',
				item: { id: 'edge', type: 'arrow', fromId: 'missing', toId: 'node' },
			},
			{
				type: 'create',
				item: {
					id: 'node',
					type: 'geo',
					geo: 'rectangle',
					x: 0,
					y: 0,
					w: 10,
					h: 10,
					text: '',
				},
			},
			{ type: 'update', id: 'edge', patch: { type: 'arrow', toId: 'node' } },
		]
	)

	expect(result).toEqual({
		code: 'validation',
		issues: [
			{
				actionIndex: 0,
				field: 'item.fromId',
				message: 'fromId must reference a geometric Canvas Item',
			},
		],
	})
})

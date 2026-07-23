import { expect, test } from 'vitest'
import { CanvasDocumentSchema, LayoutScope } from './canvas-contract'
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

test('lays out all geometric Canvas Items left-to-right with lexical topology and scoped anchoring', () => {
	const result = proposeCanvasActions(
		CanvasDocumentSchema.parse({
			items: [
				{ id: 'beta', type: 'geo', geo: 'ellipse', x: 100, y: 200, w: 100, h: 40 },
				{ id: 'alpha', type: 'geo', geo: 'rectangle', x: 500, y: 100, w: 80, h: 60 },
				{ id: 'edge', type: 'arrow', fromId: 'alpha', toId: 'beta' },
				{ id: 'gamma', type: 'geo', geo: 'diamond', x: 300, y: 300, w: 60, h: 50 },
			],
		}),
		[{ type: 'layout', direction: 'left-to-right', scope: { type: 'all' } }]
	)

	expect(result).toEqual({
		document: {
			items: [
				{ id: 'alpha', type: 'geo', geo: 'rectangle', x: 100, y: 100, w: 80, h: 60, text: '' },
				{ id: 'beta', type: 'geo', geo: 'ellipse', x: 300, y: 100, w: 100, h: 40, text: '' },
				{ id: 'edge', type: 'arrow', fromId: 'alpha', toId: 'beta' },
				{ id: 'gamma', type: 'geo', geo: 'diamond', x: 100, y: 320, w: 60, h: 50, text: '' },
			],
		},
		changedIds: ['alpha', 'beta', 'gamma', 'edge'],
		deletedIds: [],
		layoutArrowDirections: new Map([['edge', 'left-to-right']]),
	})
})

test('lays out an explicit scope whose Canvas Items and Bound Arrow are created later in the batch', () => {
	const result = proposeCanvasActions(
		{ items: [] },
		[
			{ type: 'layout', direction: 'left-to-right', scope: { type: 'items', itemIds: ['node-a', 'node-b'] } },
			{ type: 'create', item: { id: 'edge', type: 'arrow', fromId: 'node-a', toId: 'node-b' } },
			{ type: 'create', item: { id: 'node-a', type: 'geo', geo: 'rectangle', x: 500, y: 100, w: 80, h: 60, text: '' } },
			{ type: 'create', item: { id: 'node-b', type: 'geo', geo: 'ellipse', x: 100, y: 300, w: 100, h: 40, text: '' } },
		]
	)

	expect(result).toEqual({
		document: {
			items: [
				{ id: 'edge', type: 'arrow', fromId: 'node-a', toId: 'node-b' },
				{ id: 'node-a', type: 'geo', geo: 'rectangle', x: 100, y: 100, w: 80, h: 60, text: '' },
				{ id: 'node-b', type: 'geo', geo: 'ellipse', x: 300, y: 100, w: 100, h: 40, text: '' },
			],
		},
		changedIds: ['edge', 'node-a', 'node-b'],
		deletedIds: [],
		layoutArrowDirections: new Map([['edge', 'left-to-right']]),
	})
})

test('recomputes a frame created after laying out its existing members', () => {
	const result = proposeCanvasActions(
		CanvasDocumentSchema.parse({
			items: [
				{ id: 'node-a', type: 'geo', geo: 'rectangle', x: 500, y: 100, w: 80, h: 60 },
				{ id: 'node-b', type: 'geo', geo: 'ellipse', x: 100, y: 300, w: 100, h: 40 },
				{ id: 'edge', type: 'arrow', fromId: 'node-a', toId: 'node-b' },
			],
		}),
		[
			{ type: 'layout', direction: 'left-to-right', scope: { type: 'all' } },
			{ type: 'create', item: { id: 'frame', type: 'frame', x: 0, y: 0, w: 1, h: 1, memberIds: ['node-a', 'node-b'] } },
		]
	)

	if ('code' in result) throw new Error('Expected valid layout')
	expect(result.document.items).toMatchObject([
		{ id: 'edge', type: 'arrow', fromId: 'node-a', toId: 'node-b' },
		{ id: 'frame', type: 'frame', x: 20, y: 20, w: 460, h: 220, memberIds: ['node-a', 'node-b'] },
		{ id: 'node-a', type: 'geo', x: 100, y: 100, w: 80, h: 60 },
		{ id: 'node-b', type: 'geo', x: 300, y: 100, w: 100, h: 40 },
	])
})

test('uses updates after a deferred layout when anchoring a later layout', () => {
	const result = proposeCanvasActions(
		{ items: [] },
		[
			{ type: 'layout', direction: 'left-to-right', scope: { type: 'items', itemIds: ['node-a', 'node-b'] } },
			{ type: 'create', item: { id: 'edge', type: 'arrow', fromId: 'node-a', toId: 'node-b' } },
			{ type: 'create', item: { id: 'node-a', type: 'geo', geo: 'rectangle', x: 500, y: 100, w: 80, h: 60, text: '' } },
			{ type: 'create', item: { id: 'node-b', type: 'geo', geo: 'ellipse', x: 100, y: 300, w: 100, h: 40, text: '' } },
			{ type: 'update', id: 'node-a', patch: { type: 'geo', x: 1_000 } },
			{ type: 'layout', direction: 'left-to-right', scope: { type: 'all' } },
		]
	)

	if ('code' in result) throw new Error('Expected valid layouts')
	expect(result.document.items).toMatchObject([
		{ id: 'edge', type: 'arrow', fromId: 'node-a', toId: 'node-b' },
		{ id: 'node-a', type: 'geo', x: 300, y: 100, w: 80, h: 60 },
		{ id: 'node-b', type: 'geo', x: 500, y: 100, w: 100, h: 40 },
	])
})

test('lays out a frame top-to-bottom, breaks cycles lexically, and resizes around stationary text', () => {
	const result = proposeCanvasActions(
		CanvasDocumentSchema.parse({
			items: [
				{ id: 'frame', type: 'frame', x: 0, y: 0, w: 1, h: 1, memberIds: ['label', 'a', 'b', 'c'] },
				{ id: 'label', type: 'text', x: 0, y: 0, text: 'Stationary' },
				{ id: 'a', type: 'geo', geo: 'rectangle', x: 300, y: 100, w: 30, h: 40 },
				{ id: 'b', type: 'geo', geo: 'ellipse', x: 100, y: 400, w: 50, h: 50 },
				{ id: 'c', type: 'geo', geo: 'diamond', x: 200, y: 200, w: 40, h: 60 },
				{ id: 'a-b', type: 'arrow', fromId: 'a', toId: 'b' },
				{ id: 'b-c', type: 'arrow', fromId: 'b', toId: 'c' },
				{ id: 'c-a', type: 'arrow', fromId: 'c', toId: 'a' },
			],
		}),
		[{ type: 'layout', direction: 'top-to-bottom', scope: { type: 'frame', frameId: 'frame' } }]
	)

	expect(result).toEqual({
		document: {
			items: [
				{ id: 'a', type: 'geo', geo: 'rectangle', x: 100, y: 100, w: 30, h: 40, text: '' },
				{ id: 'a-b', type: 'arrow', fromId: 'a', toId: 'b' },
				{ id: 'b', type: 'geo', geo: 'ellipse', x: 100, y: 260, w: 50, h: 50, text: '' },
				{ id: 'b-c', type: 'arrow', fromId: 'b', toId: 'c' },
				{ id: 'c', type: 'geo', geo: 'diamond', x: 100, y: 430, w: 40, h: 60, text: '' },
				{ id: 'c-a', type: 'arrow', fromId: 'c', toId: 'a' },
				{ id: 'frame', type: 'frame', x: -80, y: -80, w: 310, h: 650, memberIds: ['label', 'a', 'b', 'c'] },
				{ id: 'label', type: 'text', x: 0, y: 0, text: 'Stationary' },
			],
		},
		changedIds: ['a', 'b', 'c', 'frame', 'a-b', 'b-c', 'c-a'],
		deletedIds: [],
		layoutArrowDirections: new Map([
			['a-b', 'top-to-bottom'],
			['b-c', 'top-to-bottom'],
			['c-a', 'top-to-bottom'],
		]),
	})
})

test('uses nearest-cardinal bindings when a later layout makes an arrow cross-scope', () => {
	const result = proposeCanvasActions(
		CanvasDocumentSchema.parse({
			items: [
				{ id: 'a', type: 'geo', geo: 'rectangle', x: 0, y: 0, w: 40, h: 40 },
				{ id: 'b', type: 'geo', geo: 'ellipse', x: 100, y: 0, w: 40, h: 40 },
				{ id: 'c', type: 'geo', geo: 'diamond', x: 0, y: 100, w: 40, h: 40 },
				{ id: 'edge', type: 'arrow', fromId: 'a', toId: 'b' },
			],
		}),
		[
			{ type: 'layout', direction: 'left-to-right', scope: { type: 'all' } },
			{ type: 'layout', direction: 'top-to-bottom', scope: { type: 'items', itemIds: ['b', 'c'] } },
		]
	)

	if ('code' in result) throw new Error('Expected valid layouts')
	expect(result.layoutArrowDirections).toEqual(new Map([['edge', undefined]]))
})

test.each([
	[{ type: 'all' }, 'scope', 'Auto-layout scope must contain at least one geometric Canvas Item'],
	[{ type: 'items', itemIds: ['node', 'node'] }, 'scope.itemIds.1', 'appears more than once'],
	[{ type: 'items', itemIds: ['missing'] }, 'scope.itemIds.0', 'was not found'],
	[{ type: 'items', itemIds: ['label'] }, 'scope.itemIds.0', 'must be geometric'],
	[{ type: 'frame', frameId: 'missing' }, 'scope.frameId', 'is not a frame'],
] as const)('rejects invalid Auto-layout scopes without proposing a document change', (scope, field, message) => {
	const result = proposeCanvasActions(
		CanvasDocumentSchema.parse({
			items:
				scope.type === 'all'
					? [{ id: 'label', type: 'text', x: 0, y: 0, text: 'Text' }]
					: [
						{ id: 'label', type: 'text', x: 0, y: 0, text: 'Text' },
						{ id: 'node', type: 'geo', geo: 'rectangle', x: 0, y: 0, w: 10, h: 10 },
					],
		}),
		[{ type: 'layout', direction: 'left-to-right', scope: scope as LayoutScope }]
	)

	expect(result).toMatchObject({ code: 'validation', issues: [{ actionIndex: 0, field, message: expect.stringContaining(message) }] })
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

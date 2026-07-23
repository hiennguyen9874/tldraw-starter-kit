import { expect, test } from 'vitest'
import { proposeCanvasActions } from '../client/canvas/proposeCanvasActions'

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

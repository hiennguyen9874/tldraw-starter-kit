export const CANVAS_EXPORT_FIXTURE = {
	version: 1,
	actions: [
		{
			type: 'create',
			item: {
				id: 'fixture-frame',
				type: 'frame',
				x: 0,
				y: 0,
				w: 640,
				h: 320,
				memberIds: ['fixture-title', 'fixture-rectangle', 'fixture-ellipse', 'fixture-diamond'],
			},
		},
		{ type: 'create', item: { id: 'fixture-arrow-one', type: 'arrow', fromId: 'fixture-rectangle', toId: 'fixture-ellipse' } },
		{ type: 'create', item: { id: 'fixture-arrow-two', type: 'arrow', fromId: 'fixture-ellipse', toId: 'fixture-diamond' } },
		{ type: 'create', item: { id: 'fixture-title', type: 'text', x: 32, y: 32, text: 'Canvas Export Fixture' } },
		{
			type: 'create',
			item: { id: 'fixture-rectangle', type: 'geo', geo: 'rectangle', x: 48, y: 128, w: 120, h: 80, text: 'Rectangle' },
		},
		{
			type: 'create',
			item: { id: 'fixture-ellipse', type: 'geo', geo: 'ellipse', x: 256, y: 128, w: 120, h: 80, text: 'Ellipse' },
		},
		{
			type: 'create',
			item: { id: 'fixture-diamond', type: 'geo', geo: 'diamond', x: 464, y: 128, w: 120, h: 80, text: 'Diamond' },
		},
	],
} as const

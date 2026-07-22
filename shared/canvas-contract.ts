import { z } from 'zod'

export const CANVAS_CONTRACT_VERSION = 1

const FiniteNumberSchema = z.number().finite()
const PositiveNumberSchema = FiniteNumberSchema.positive()

export const RevisionSchema = z.number().int().nonnegative()
export type Revision = z.infer<typeof RevisionSchema>

export const CanvasItemIdSchema = z.string().min(1)
export type CanvasItemId = z.infer<typeof CanvasItemIdSchema>

export const RectSchema = z
	.strictObject({
		x: FiniteNumberSchema,
		y: FiniteNumberSchema,
		w: PositiveNumberSchema,
		h: PositiveNumberSchema,
	})
	.describe('A canvas rectangle with top-left x/y coordinates and positive width/height.')
export type Rect = z.infer<typeof RectSchema>

const PositionedCanvasItemSchema = {
	id: CanvasItemIdSchema,
	x: FiniteNumberSchema,
	y: FiniteNumberSchema,
}

export const TextCanvasItemSchema = z
	.strictObject({
		...PositionedCanvasItemSchema,
		type: z.literal('text'),
		text: z.string(),
	})
	.describe('Text is positioned by its top-left origin and sized by the Canvas Runtime.')
export type TextCanvasItem = z.infer<typeof TextCanvasItemSchema>

export const GeometricCanvasItemSchema = z
	.strictObject({
		...PositionedCanvasItemSchema,
		type: z.literal('geo'),
		geo: z.enum(['rectangle', 'ellipse', 'diamond']),
		w: PositiveNumberSchema,
		h: PositiveNumberSchema,
		text: z.string().default(''),
	})
	.describe('A supported geometric Canvas Item.')
export type GeometricCanvasItem = z.infer<typeof GeometricCanvasItemSchema>

export const BoundArrowCanvasItemSchema = z
	.strictObject({
		id: CanvasItemIdSchema,
		type: z.literal('arrow'),
		fromId: CanvasItemIdSchema,
		toId: CanvasItemIdSchema,
	})
	.refine(({ fromId, toId }) => fromId !== toId, {
		path: ['toId'],
		message: 'A Bound Arrow cannot bind a Canvas Item to itself',
	})
	.describe('A directed connection between distinct geometric Canvas Items.')
export type BoundArrowCanvasItem = z.infer<typeof BoundArrowCanvasItemSchema>

export const FrameCanvasItemSchema = z
	.strictObject({
		...PositionedCanvasItemSchema,
		type: z.literal('frame'),
		w: PositiveNumberSchema,
		h: PositiveNumberSchema,
		memberIds: z.array(CanvasItemIdSchema),
	})
	.describe('A non-nesting group whose members retain their absolute coordinates.')
export type FrameCanvasItem = z.infer<typeof FrameCanvasItemSchema>

export const CanvasItemSchema = z.discriminatedUnion('type', [
	TextCanvasItemSchema,
	GeometricCanvasItemSchema,
	BoundArrowCanvasItemSchema,
	FrameCanvasItemSchema,
])
export type CanvasItem = z.infer<typeof CanvasItemSchema>

function compareCanvasItemIds(left: CanvasItem, right: CanvasItem) {
	if (left.id === right.id) return 0
	return left.id < right.id ? -1 : 1
}

export const CanvasDocumentInputSchema = z
	.strictObject({ items: z.array(CanvasItemSchema) })
	.superRefine((document, ctx) => {
		const itemsById = new Map<string, CanvasItem>()
		const frameMembership = new Map<string, string>()

		for (const [index, item] of document.items.entries()) {
			if (itemsById.has(item.id)) {
				ctx.addIssue({
					code: 'custom',
					path: ['items', index, 'id'],
					message: `Canvas Item ID "${item.id}" must be unique`,
				})
			}
			itemsById.set(item.id, item)
		}

		for (const [index, item] of document.items.entries()) {
			if (item.type === 'arrow') {
				for (const endpoint of ['fromId', 'toId'] as const) {
					const target = itemsById.get(item[endpoint])
					if (!target || target.type !== 'geo') {
						ctx.addIssue({
							code: 'custom',
							path: ['items', index, endpoint],
							message: `${endpoint} must reference a geometric Canvas Item`,
						})
					}
				}
			}

			if (item.type === 'frame') {
				const memberIds = new Set<string>()
				for (const [memberIndex, memberId] of item.memberIds.entries()) {
					if (memberIds.has(memberId)) {
						ctx.addIssue({
							code: 'custom',
							path: ['items', index, 'memberIds', memberIndex],
							message: `Frame member "${memberId}" must appear only once`,
						})
					}
					memberIds.add(memberId)

					const member = itemsById.get(memberId)
					if (!member || (member.type !== 'text' && member.type !== 'geo')) {
						ctx.addIssue({
							code: 'custom',
							path: ['items', index, 'memberIds', memberIndex],
							message: 'Frame members must reference text or geometric Canvas Items',
						})
					}

					const containingFrame = frameMembership.get(memberId)
					if (containingFrame) {
						ctx.addIssue({
							code: 'custom',
							path: ['items', index, 'memberIds', memberIndex],
							message: `Canvas Item "${memberId}" is already a member of frame "${containingFrame}"`,
						})
					} else {
						frameMembership.set(memberId, item.id)
					}
				}
			}
		}
	})

export function canonicalizeCanvasDocument(document: z.input<typeof CanvasDocumentInputSchema>) {
	const parsedDocument = CanvasDocumentInputSchema.parse(document)
	return {
		items: [...parsedDocument.items].sort(compareCanvasItemIds),
	}
}

export const CanvasDocumentSchema = CanvasDocumentInputSchema.transform(canonicalizeCanvasDocument)
export type CanvasDocument = z.infer<typeof CanvasDocumentSchema>

const TextCanvasItemPatchSchema = z
	.strictObject({
		type: z.literal('text'),
		x: FiniteNumberSchema.optional(),
		y: FiniteNumberSchema.optional(),
		text: z.string().optional(),
	})
	.refine(({ x, y, text }) => x !== undefined || y !== undefined || text !== undefined, {
		message: 'A Canvas Item patch must change at least one field',
	})

const GeometricCanvasItemPatchSchema = z
	.strictObject({
		type: z.literal('geo'),
		x: FiniteNumberSchema.optional(),
		y: FiniteNumberSchema.optional(),
		w: PositiveNumberSchema.optional(),
		h: PositiveNumberSchema.optional(),
		text: z.string().optional(),
	})
	.refine(
		({ x, y, w, h, text }) =>
			x !== undefined || y !== undefined || w !== undefined || h !== undefined || text !== undefined,
		{ message: 'A Canvas Item patch must change at least one field' }
	)

const BoundArrowCanvasItemPatchSchema = z
	.strictObject({
		type: z.literal('arrow'),
		fromId: CanvasItemIdSchema.optional(),
		toId: CanvasItemIdSchema.optional(),
	})
	.refine(({ fromId, toId }) => fromId !== undefined || toId !== undefined, {
		message: 'A Canvas Item patch must change at least one field',
	})

const FrameCanvasItemPatchSchema = z
	.strictObject({
		type: z.literal('frame'),
		memberIds: z.array(CanvasItemIdSchema).optional(),
	})
	.refine(({ memberIds }) => memberIds !== undefined, {
		message: 'A Canvas Item patch must change at least one field',
	})

export const CanvasItemPatchSchema = z.discriminatedUnion('type', [
	TextCanvasItemPatchSchema,
	GeometricCanvasItemPatchSchema,
	BoundArrowCanvasItemPatchSchema,
	FrameCanvasItemPatchSchema,
])
export type CanvasItemPatch = z.infer<typeof CanvasItemPatchSchema>

export const LayoutScopeSchema = z.discriminatedUnion('type', [
	z.strictObject({ type: z.literal('all') }),
	z.strictObject({ type: z.literal('frame'), frameId: CanvasItemIdSchema }),
	z.strictObject({ type: z.literal('items'), itemIds: z.array(CanvasItemIdSchema).min(1) }),
])
export type LayoutScope = z.infer<typeof LayoutScopeSchema>

export const CanvasActionSchema = z.discriminatedUnion('type', [
	z.strictObject({ type: z.literal('create'), item: CanvasItemSchema }),
	z.strictObject({
		type: z.literal('update'),
		id: CanvasItemIdSchema,
		patch: CanvasItemPatchSchema,
	}),
	z.strictObject({ type: z.literal('delete'), id: CanvasItemIdSchema }),
	z.strictObject({
		type: z.literal('layout'),
		direction: z.enum(['left-to-right', 'top-to-bottom']),
		scope: LayoutScopeSchema,
	}),
])
export type CanvasAction = z.infer<typeof CanvasActionSchema>

export const ApplyActionsInputSchema = z.strictObject({
	expectedRevision: RevisionSchema,
	actions: z.array(CanvasActionSchema).min(1),
})
export type ApplyActionsInput = z.infer<typeof ApplyActionsInputSchema>

export const GetContextInputSchema = z.strictObject({})
export type GetContextInput = z.infer<typeof GetContextInputSchema>

export const CaptureInputSchema = z.strictObject({
	expectedRevision: RevisionSchema.optional(),
	rect: RectSchema.optional(),
})
export type CaptureInput = z.infer<typeof CaptureInputSchema>

export const ExportInputSchema = CaptureInputSchema.extend({
	format: z.enum(['png', 'svg']),
})
export type ExportInput = z.infer<typeof ExportInputSchema>

export const CanvasToolRequestSchema = z.discriminatedUnion('tool', [
	z.strictObject({
		version: z.literal(CANVAS_CONTRACT_VERSION),
		id: z.string().min(1),
		tool: z.literal('canvas.get_context'),
		input: GetContextInputSchema,
	}),
	z.strictObject({
		version: z.literal(CANVAS_CONTRACT_VERSION),
		id: z.string().min(1),
		tool: z.literal('canvas.apply_actions'),
		input: ApplyActionsInputSchema,
	}),
	z.strictObject({
		version: z.literal(CANVAS_CONTRACT_VERSION),
		id: z.string().min(1),
		tool: z.literal('canvas.capture'),
		input: CaptureInputSchema,
	}),
	z.strictObject({
		version: z.literal(CANVAS_CONTRACT_VERSION),
		id: z.string().min(1),
		tool: z.literal('canvas.export'),
		input: ExportInputSchema,
	}),
])
export type CanvasToolRequest = z.infer<typeof CanvasToolRequestSchema>

export const BusinessErrorSchema = z.discriminatedUnion('code', [
	z.strictObject({
		code: z.literal('stale_revision'),
		expectedRevision: RevisionSchema,
		currentRevision: RevisionSchema,
	}),
	z.strictObject({
		code: z.literal('validation'),
		issues: z
			.array(
				z.strictObject({
					message: z.string().min(1),
					actionIndex: z.number().int().nonnegative().optional(),
					field: z.string().min(1).optional(),
				})
			)
			.min(1),
	}),
	z.strictObject({ code: z.literal('not_found'), id: CanvasItemIdSchema.optional() }),
	z.strictObject({ code: z.literal('unavailable') }),
	z.strictObject({ code: z.literal('replaced') }),
	z.strictObject({ code: z.literal('busy') }),
	z.strictObject({ code: z.literal('timeout') }),
])
export type BusinessError = z.infer<typeof BusinessErrorSchema>

export const GetContextResultSchema = z.strictObject({
	revision: RevisionSchema,
	document: CanvasDocumentSchema,
	contentBounds: RectSchema.nullable(),
})

export const ApplyActionsResultSchema = z.strictObject({
	revision: RevisionSchema,
	changedIds: z.array(CanvasItemIdSchema),
	deletedIds: z.array(CanvasItemIdSchema),
})

export const CaptureResultSchema = z.strictObject({
	revision: RevisionSchema,
	rect: RectSchema,
	content: z.strictObject({
		type: z.literal('image'),
		mimeType: z.literal('image/png'),
		data: z.string(),
	}),
})

export const ExportResultSchema = z.strictObject({
	revision: RevisionSchema,
	rect: RectSchema,
	mimeType: z.enum(['image/png', 'image/svg+xml']),
	data: z.string(),
})

export const CanvasToolResponseSchema = z.union([
	z.strictObject({
		version: z.literal(CANVAS_CONTRACT_VERSION),
		id: z.string().min(1),
		ok: z.literal(true),
		tool: z.literal('canvas.get_context'),
		result: GetContextResultSchema,
	}),
	z.strictObject({
		version: z.literal(CANVAS_CONTRACT_VERSION),
		id: z.string().min(1),
		ok: z.literal(true),
		tool: z.literal('canvas.apply_actions'),
		result: ApplyActionsResultSchema,
	}),
	z.strictObject({
		version: z.literal(CANVAS_CONTRACT_VERSION),
		id: z.string().min(1),
		ok: z.literal(true),
		tool: z.literal('canvas.capture'),
		result: CaptureResultSchema,
	}),
	z.strictObject({
		version: z.literal(CANVAS_CONTRACT_VERSION),
		id: z.string().min(1),
		ok: z.literal(true),
		tool: z.literal('canvas.export'),
		result: ExportResultSchema,
	}),
	z.strictObject({
		version: z.literal(CANVAS_CONTRACT_VERSION),
		id: z.string().min(1),
		ok: z.literal(false),
		tool: z.enum([
			'canvas.get_context',
			'canvas.apply_actions',
			'canvas.capture',
			'canvas.export',
		]),
		error: BusinessErrorSchema,
	}),
])
export type CanvasToolResponse = z.infer<typeof CanvasToolResponseSchema>

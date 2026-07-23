import {
	Editor,
	TLArrowShape,
	TLFrameShape,
	TLGeoShape,
	TLShape,
	TLTextShape,
	createShapeId,
	toRichText,
} from 'tldraw'
import {
	ApplyActionsInput,
	ApplyActionsResultSchema,
	CanvasDocument,
	CanvasDocumentSchema,
	CanvasItem,
	GeometricCanvasItem,
	GetContextResultSchema,
	Revision,
	RevisionSchema,
} from '../../shared/canvas-contract'
import { proposeCanvasActions } from './proposeCanvasActions'

export const CANVAS_RUNTIME_STORAGE_KEY = 'canvas-runtime-v1'

const SUPPORTED_GEOS = new Set<string>(['rectangle', 'ellipse', 'diamond'])
// Default geo strokes are 3.5 units wide and their draw-style paths extend slightly beyond the model box.
const RENDERED_GEO_INK_MARGIN = 4
type CanvasShape = Parameters<Editor['createShapes']>[0][number]

interface CanvasRuntimeStorage {
	getItem(key: string): string | null
	setItem(key: string, value: string): void
}

interface PersistedCanvasRuntime {
	version: 1
	revision: Revision
	document: CanvasDocument
}

export class CanvasRuntime {
	private document: CanvasDocument
	private revision: Revision
	private isSynchronizing = false
	private isReplayingHistory = false
	private synchronizationTimer: ReturnType<typeof setTimeout> | undefined
	private readonly removeCanvasItemGuards: () => void
	private readonly removeStoreListener: () => void
	private readonly removePageHideListener: () => void
	private readonly restoreTransactionBoundaries: () => void

	constructor(
		private readonly editor: Editor,
		private readonly storage: CanvasRuntimeStorage = window.localStorage
	) {
		const persisted = loadPersistedCanvasRuntime(storage)
		this.document = persisted.document
		this.revision = persisted.revision

		this.hydrateEditor()
		this.removeCanvasItemGuards = this.guardCanvasItemShapes()
		this.restoreTransactionBoundaries = this.observeTransactionBoundaries()
		this.removeStoreListener = editor.store.listen(
			() => this.scheduleSynchronization(),
			{ source: 'user', scope: 'document' }
		)
		const handlePageHide = () => this.flushSynchronization()
		window.addEventListener('pagehide', handlePageHide)
		this.removePageHideListener = () => window.removeEventListener('pagehide', handlePageHide)
	}

	getContext() {
		this.flushSynchronization()
		return GetContextResultSchema.parse({
			revision: this.revision,
			document: this.document,
			contentBounds: this.getContentBounds(),
		})
	}

	applyActions(input: ApplyActionsInput) {
		this.flushSynchronization()
		if (input.expectedRevision !== this.revision) {
			return {
				code: 'stale_revision' as const,
				expectedRevision: input.expectedRevision,
				currentRevision: this.revision,
			}
		}

		const proposed = proposeCanvasActions(this.document, input.actions)
		if ('code' in proposed) return proposed

		this.replaceDocument(proposed.document)
		return ApplyActionsResultSchema.parse({
			revision: this.revision,
			changedIds: proposed.changedIds,
			deletedIds: proposed.deletedIds,
		})
	}

	dispose() {
		this.removeCanvasItemGuards()
		this.removeStoreListener()
		this.removePageHideListener()
		this.restoreTransactionBoundaries()
		this.flushSynchronization()
	}

	private hydrateEditor() {
		this.replaceEditorDocument(this.document, 'ignore')
	}

	private replaceDocument(document: CanvasDocument) {
		this.editor.markHistoryStoppingPoint('canvas.apply_actions')
		this.replaceEditorDocument(document, 'record')
		this.document = document
		this.revision += 1
		this.persist()
	}

	private replaceEditorDocument(document: CanvasDocument, history: 'ignore' | 'record') {
		this.isSynchronizing = true
		try {
			this.editor.run(() => {
				this.editor.deleteShapes(this.getSupportedShapes())
				const shapes = document.items.map((item) => canvasItemToShape(item, document))
				this.editor.createShapes(shapes)
				createArrowBindings(this.editor, document, shapes)
			}, { history })
		} finally {
			this.isSynchronizing = false
		}
	}

	private guardCanvasItemShapes() {
		const removeBeforeCreate = this.editor.sideEffects.registerBeforeCreateHandler('shape', (shape) => {
			return isSupportedShape(shape) ? canonicalizeNewCanvasItemShape(this.editor, shape) : shape
		})
		const removeBeforeChange = this.editor.sideEffects.registerBeforeChangeHandler(
			'shape',
			(shapeBefore, shapeAfter) => {
				if (this.isSynchronizing || !isSupportedShape(shapeBefore) || !isSupportedShape(shapeAfter)) {
					return shapeAfter
				}
				return isSupportedCanvasItemChange(shapeBefore, shapeAfter)
					? canonicalizeCanvasItemChange(shapeAfter)
					: shapeBefore
			}
		)
		const removeBeforeDelete = this.editor.sideEffects.registerBeforeDeleteHandler('shape', (shape) => {
			if (this.isSynchronizing || this.isReplayingHistory || !isSupportedShape(shape)) return
			const id = getPublicId(shape)
			if (!id) return false

			const proposed = proposeCanvasActions(this.document, [{ type: 'delete', id }])
			if ('code' in proposed) return false

			this.isSynchronizing = true
			try {
				this.replaceDocument(proposed.document)
			} finally {
				this.isSynchronizing = false
			}
			return false
		})

		return () => {
			removeBeforeCreate()
			removeBeforeChange()
			removeBeforeDelete()
		}
	}

	private observeTransactionBoundaries() {
		// Store changes arrive per frame or keystroke; history boundaries define one direct-edit undo step.
		const originalMark = this.editor.markHistoryStoppingPoint
		const originalUndo = this.editor.undo
		const originalRedo = this.editor.redo

		this.editor.markHistoryStoppingPoint = (name) => {
			this.flushSynchronization()
			return originalMark.call(this.editor, name)
		}
		this.editor.undo = () => {
			this.flushSynchronization()
			this.isReplayingHistory = true
			try {
				return originalUndo.call(this.editor)
			} finally {
				this.isReplayingHistory = false
			}
		}
		this.editor.redo = () => {
			this.flushSynchronization()
			this.isReplayingHistory = true
			try {
				return originalRedo.call(this.editor)
			} finally {
				this.isReplayingHistory = false
			}
		}

		return () => {
			this.editor.markHistoryStoppingPoint = originalMark
			this.editor.undo = originalUndo
			this.editor.redo = originalRedo
		}
	}

	private scheduleSynchronization() {
		if (this.isSynchronizing) return
		if (this.synchronizationTimer) clearTimeout(this.synchronizationTimer)
		this.synchronizationTimer = setTimeout(() => this.flushSynchronization(), 100)
	}

	private flushSynchronization() {
		if (this.synchronizationTimer) clearTimeout(this.synchronizationTimer)
		this.synchronizationTimer = undefined
		this.synchronizeFromEditor()
	}

	private synchronizeFromEditor() {
		if (this.isSynchronizing) return

		this.isSynchronizing = true
		try {
			const shapes = this.editor.getCurrentPageShapes()
			const unsupportedShapeIds = shapes
				.filter((shape) => !isSupportedShape(shape))
				.map((shape) => shape.id)
			if (unsupportedShapeIds.length > 0) {
				this.editor.run(() => this.editor.deleteShapes(unsupportedShapeIds), { history: 'ignore' })
			}

			const supportedShapes = this.getSupportedShapes()
			const publicIds = new Set<string>()
			const shapesNeedingPublicIds = supportedShapes.filter((shape) => {
				const publicId = getPublicId(shape)
				if (!publicId || publicIds.has(publicId)) return true
				publicIds.add(publicId)
				return false
			})
			if (shapesNeedingPublicIds.length > 0) {
				this.editor.run(() => {
					this.editor.updateShapes(
						shapesNeedingPublicIds.map((shape) => {
							const publicId = uniquePublicIdForShape(shape, publicIds)
							publicIds.add(publicId)
							return {
								id: shape.id,
								type: shape.type,
								meta: { ...shape.meta, canvasItemId: publicId },
							}
						})
					)
				}, { history: 'ignore' })
			}

			const document = CanvasDocumentSchema.parse({
				items: this.getSupportedShapes().map((shape) => shapeToCanvasItem(this.editor, shape)),
			})
			if (JSON.stringify(document) === JSON.stringify(this.document)) return

			this.document = document
			this.revision += 1
			this.persist()
		} finally {
			this.isSynchronizing = false
		}
	}

	private persist() {
		this.storage.setItem(
			CANVAS_RUNTIME_STORAGE_KEY,
			JSON.stringify({ version: 1, revision: this.revision, document: this.document })
		)
	}

	private getSupportedShapes() {
		return this.editor.getCurrentPageShapes().filter(isSupportedShape)
	}

	private getContentBounds() {
		const shapeBounds = this.getSupportedShapes().flatMap((shape) => {
			const bounds = this.editor.getShapePageBounds(shape)
			if (!bounds) return []

			const margin = shape.type === 'geo' ? RENDERED_GEO_INK_MARGIN : 0
			return [
				{
					x: bounds.x - margin,
					y: bounds.y - margin,
					w: bounds.w + margin * 2,
					h: bounds.h + margin * 2,
				},
			]
		})
		if (shapeBounds.length === 0) return null

		const minX = Math.min(...shapeBounds.map((bounds) => bounds.x))
		const minY = Math.min(...shapeBounds.map((bounds) => bounds.y))
		const maxX = Math.max(...shapeBounds.map((bounds) => bounds.x + bounds.w))
		const maxY = Math.max(...shapeBounds.map((bounds) => bounds.y + bounds.h))
		return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
	}
}

function loadPersistedCanvasRuntime(storage: CanvasRuntimeStorage): PersistedCanvasRuntime {
	const blank: PersistedCanvasRuntime = { version: 1, revision: 0, document: { items: [] } }
	const raw = storage.getItem(CANVAS_RUNTIME_STORAGE_KEY)
	if (!raw) return blank

	try {
		const parsed: unknown = JSON.parse(raw)
		if (!isRecord(parsed) || parsed.version !== 1) return blank
		const revision = RevisionSchema.safeParse(parsed.revision)
		const document = CanvasDocumentSchema.safeParse(parsed.document)
		if (!revision.success || !document.success) return blank
		return { version: 1, revision: revision.data, document: document.data }
	} catch {
		return blank
	}
}

function isSupportedShape(
	shape: TLShape
): shape is TLTextShape | TLGeoShape | TLArrowShape | TLFrameShape {
	return (
		shape.type === 'text' ||
		(shape.type === 'geo' && SUPPORTED_GEOS.has(shape.props.geo)) ||
		shape.type === 'arrow' ||
		shape.type === 'frame'
	)
}

function canonicalizeNewCanvasItemShape(
	editor: Editor,
	shape: TLTextShape | TLGeoShape | TLArrowShape | TLFrameShape
): TLTextShape | TLGeoShape | TLArrowShape | TLFrameShape {
	if (shape.type === 'arrow' || shape.type === 'frame') return shape
	const defaultProps = editor.getShapeUtil(shape).getDefaultProps()
	const props =
		shape.type === 'text'
			? { ...defaultProps, autoSize: true, richText: toRichText(plainText(shape.props.richText)) }
			: {
					...defaultProps,
					geo: shape.props.geo,
					w: shape.props.w,
					h: shape.props.h,
					richText: toRichText(plainText(shape.props.richText)),
				}

	return { ...shape, rotation: 0, opacity: 1, isLocked: false, props } as TLTextShape | TLGeoShape
}

function isSupportedCanvasItemChange(
	shapeBefore: TLTextShape | TLGeoShape | TLArrowShape | TLFrameShape,
	shapeAfter: TLTextShape | TLGeoShape | TLArrowShape | TLFrameShape
) {
	if (
		shapeBefore.type === 'arrow' ||
		shapeBefore.type === 'frame' ||
		shapeAfter.type === 'arrow' ||
		shapeAfter.type === 'frame' ||
		shapeBefore.type !== shapeAfter.type ||
		shapeAfter.rotation !== 0
	) return false

	for (const key of Object.keys(shapeAfter)) {
		if (key === 'x' || key === 'y' || key === 'props') continue
		if (!sameValue(shapeBefore[key as keyof typeof shapeBefore], shapeAfter[key as keyof typeof shapeAfter])) {
			return false
		}
	}

	const allowedProps = shapeAfter.type === 'text' ? new Set(['richText', 'w']) : new Set(['w', 'h', 'richText'])
	for (const key of Object.keys(shapeAfter.props)) {
		if (allowedProps.has(key)) continue
		if (!sameValue(shapeBefore.props[key as keyof typeof shapeBefore.props], shapeAfter.props[key as keyof typeof shapeAfter.props])) {
			return false
		}
	}

	return true
}

function canonicalizeCanvasItemChange(
	shape: TLTextShape | TLGeoShape | TLArrowShape | TLFrameShape
): TLTextShape | TLGeoShape | TLArrowShape | TLFrameShape {
	if (shape.type === 'arrow' || shape.type === 'frame') return shape
	return {
		...shape,
		props: { ...shape.props, richText: toRichText(plainText(shape.props.richText)) },
	} as TLTextShape | TLGeoShape
}

function sameValue(left: unknown, right: unknown) {
	return JSON.stringify(left) === JSON.stringify(right)
}

function shapeToCanvasItem(
	editor: Editor,
	shape: TLTextShape | TLGeoShape | TLArrowShape | TLFrameShape
): CanvasItem {
	const id = getPublicId(shape)
	if (!id) throw new Error(`Canvas Runtime shape ${shape.id} has no public ID`)

	if (shape.type === 'text') {
		return { id, type: 'text', x: shape.x, y: shape.y, text: plainText(shape.props.richText) }
	}
	if (shape.type === 'geo') {
		return {
			id,
			type: 'geo',
			geo: shape.props.geo as GeometricCanvasItem['geo'],
			x: shape.x,
			y: shape.y,
			w: shape.props.w,
			h: shape.props.h,
			text: plainText(shape.props.richText),
		}
	}
	if (shape.type === 'frame') {
		return {
			id,
			type: 'frame',
			x: shape.x,
			y: shape.y,
			w: shape.props.w,
			h: shape.props.h,
			memberIds: getFrameMemberIds(shape),
		}
	}

	const bindings = new Map(
		editor
			.getBindingsFromShape(shape, 'arrow')
			.flatMap((binding) => {
				const publicId = getPublicId(editor.getShape(binding.toId) ?? ({ meta: {} } as TLShape))
				return publicId ? [[binding.props.terminal, publicId] as const] : []
			})
	)
	const fromId = bindings.get('start')
	const toId = bindings.get('end')
	if (!fromId || !toId) throw new Error(`Canvas Runtime arrow ${shape.id} is missing an endpoint`)
	return { id, type: 'arrow', fromId, toId }
}

function canvasItemToShape(item: CanvasItem, document: CanvasDocument): CanvasShape {
	const meta = { canvasItemId: item.id }
	if (item.type === 'text') {
		return { id: createShapeId(), type: 'text' as const, x: item.x, y: item.y, props: { richText: toRichText(item.text), autoSize: true }, meta }
	}
	if (item.type === 'geo') {
		return { id: createShapeId(), type: 'geo' as const, x: item.x, y: item.y, props: { geo: item.geo, w: item.w, h: item.h, richText: toRichText(item.text) }, meta }
	}
	if (item.type === 'frame') {
		return { id: createShapeId(), type: 'frame' as const, x: item.x, y: item.y, props: { w: item.w, h: item.h, name: '', color: 'black' }, meta: { ...meta, canvasMemberIds: item.memberIds } }
	}
	const from = getGeometricItem(document, item.fromId)
	const to = getGeometricItem(document, item.toId)
	const start = { x: from.x + from.w / 2, y: from.y + from.h / 2 }
	const end = { x: to.x + to.w / 2, y: to.y + to.h / 2 }
	const x = Math.min(start.x, end.x)
	const y = Math.min(start.y, end.y)
	return { id: createShapeId(), type: 'arrow' as const, x, y, props: { kind: 'arc', start: { x: start.x - x, y: start.y - y }, end: { x: end.x - x, y: end.y - y }, bend: 0, color: 'black', fill: 'none', dash: 'solid', size: 'm', arrowheadStart: 'none', arrowheadEnd: 'arrow', font: 'draw', richText: toRichText(''), labelPosition: 0.5, labelColor: 'black', scale: 1, elbowMidPoint: 0.5 }, meta } as unknown as CanvasShape
}

function createArrowBindings(
	editor: Editor,
	document: CanvasDocument,
	shapes: CanvasShape[]
) {
	const shapeIds = new Map(
		shapes.flatMap((shape) => {
			const publicId = shape.meta?.canvasItemId
			return typeof publicId === 'string' ? [[publicId, shape.id] as const] : []
		})
	)
	for (const item of document.items) {
		if (item.type !== 'arrow') continue
		const arrowId = shapeIds.get(item.id)
		const fromId = shapeIds.get(item.fromId)
		const toId = shapeIds.get(item.toId)
		if (!arrowId || !fromId || !toId) throw new Error(`Canvas Runtime arrow ${item.id} has no native endpoint`)
		editor.createBindings([
			{ type: 'arrow', fromId: arrowId, toId: fromId, props: { terminal: 'start', normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: true, snap: 'edge' } },
			{ type: 'arrow', fromId: arrowId, toId, props: { terminal: 'end', normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: true, snap: 'edge' } },
		])
	}
}

function getGeometricItem(document: CanvasDocument, id: string): GeometricCanvasItem {
	const item = document.items.find((candidate) => candidate.id === id)
	if (!item || item.type !== 'geo') throw new Error(`Canvas Runtime arrow endpoint ${id} is not geometric`)
	return item
}

function getFrameMemberIds(shape: TLFrameShape) {
	const memberIds = shape.meta.canvasMemberIds
	return Array.isArray(memberIds) && memberIds.every((memberId) => typeof memberId === 'string')
		? memberIds
		: []
}

function getPublicId(shape: TLShape) {
	const id = shape.meta.canvasItemId
	return typeof id === 'string' && id.length > 0 ? id : null
}

function uniquePublicIdForShape(shape: TLShape, usedIds: ReadonlySet<string>) {
	const baseId = `canvas-${shape.id.slice('shape:'.length)}`
	let id = baseId
	let suffix = 2
	while (usedIds.has(id)) id = `${baseId}-${suffix++}`
	return id
}

function plainText(richText: unknown): string {
	return readRichTextNode(richText).join('\n')
}

function readRichTextNode(node: unknown): string[] {
	if (!isRecord(node)) return []
	if (typeof node.text === 'string') return [node.text]
	if (!Array.isArray(node.content)) return []

	const content = node.content.flatMap(readRichTextNode)
	return node.type === 'doc' ? content : [content.join('')]
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null
}

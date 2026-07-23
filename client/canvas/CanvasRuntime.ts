import {
	Box,
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
	BusinessError,
	CaptureInput,
	CaptureResultSchema,
	ExportInput,
	ExportResultSchema,
	CanvasDocument,
	CanvasDocumentSchema,
	CanvasItem,
	GeometricCanvasItem,
	Rect,
	GetContextResultSchema,
	Revision,
	RevisionSchema,
} from '../../shared/canvas-contract'
import { getPaddedBounds, LayoutDirection, proposeCanvasActions } from './proposeCanvasActions'

export const CANVAS_RUNTIME_STORAGE_KEY = 'canvas-runtime-v1'

const SUPPORTED_GEOS = new Set<string>(['rectangle', 'ellipse', 'diamond'])
// Default geo strokes are 3.5 units wide and their draw-style paths extend slightly beyond the model box.
const RENDERED_GEO_INK_MARGIN = 4
const CAPTURE_PADDING = 32
const MAX_RENDER_AREA = 16_000_000
// tldraw clamps larger raster dimensions, which would desynchronize returned rect metadata from PNG output.
const MAX_RENDER_DIMENSION = 8_192
const MAX_ENCODED_ARTIFACT_BYTES = 16 * 1024 * 1024
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

type RenderPreparation =
	| { revision: Revision; rect: Rect }
	| Extract<BusinessError, { code: 'stale_revision' | 'validation' }>

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

		this.replaceDocument(proposed.document, proposed.layoutArrowDirections, proposed.changedIds)
		return ApplyActionsResultSchema.parse({
			revision: this.revision,
			changedIds: proposed.changedIds,
			deletedIds: proposed.deletedIds,
		})
	}

	async capture(input: CaptureInput) {
		const prepared = this.prepareRender(input)
		if ('code' in prepared) return prepared

		const png = await this.renderArtifact('png', prepared.rect)
		const data = await encodeArtifact(png, 'PNG', 'content.data')
		if (typeof data !== 'string') return data

		return CaptureResultSchema.parse({
			revision: prepared.revision,
			rect: prepared.rect,
			content: { type: 'image', mimeType: 'image/png', data },
		})
	}

	async export(input: ExportInput) {
		const prepared = this.prepareRender(input)
		if ('code' in prepared) return prepared

		const artifact = await this.renderArtifact(input.format, prepared.rect)
		const data = await encodeArtifact(artifact, input.format.toUpperCase(), 'data')
		if (typeof data !== 'string') return data

		return ExportResultSchema.parse({
			revision: prepared.revision,
			rect: prepared.rect,
			mimeType: input.format === 'png' ? 'image/png' : 'image/svg+xml',
			data,
		})
	}

	dispose() {
		this.removeCanvasItemGuards()
		this.removeStoreListener()
		this.removePageHideListener()
		this.restoreTransactionBoundaries()
		this.flushSynchronization()
	}

	private prepareRender(input: CaptureInput): RenderPreparation {
		this.flushSynchronization()
		const revision = this.revision
		if (input.expectedRevision !== undefined && input.expectedRevision !== revision) {
			return {
				code: 'stale_revision' as const,
				expectedRevision: input.expectedRevision,
				currentRevision: revision,
			}
		}

		const rect = input.rect ?? this.getDefaultCaptureRect()
		if (rect.w > MAX_RENDER_DIMENSION) {
			return renderValidationError(`Render width must not exceed ${MAX_RENDER_DIMENSION} pixels`, 'rect.w')
		}
		if (rect.h > MAX_RENDER_DIMENSION) {
			return renderValidationError(`Render height must not exceed ${MAX_RENDER_DIMENSION} pixels`, 'rect.h')
		}
		if (rect.w * rect.h > MAX_RENDER_AREA) {
			return renderValidationError(`Render area must not exceed ${MAX_RENDER_AREA} pixels`, 'rect')
		}
		return { revision, rect }
	}

	private async renderArtifact(format: ExportInput['format'], rect: Rect) {
		const shapes = this.getSupportedShapes()
		if (shapes.length === 0) {
			return format === 'png' ? transparentPngBlob(rect.w, rect.h) : transparentSvgBlob(rect.w, rect.h)
		}
		const { blob } = await this.editor.toImage(shapes, {
			format,
			bounds: new Box(rect.x, rect.y, rect.w, rect.h),
			background: false,
			padding: 0,
			pixelRatio: 1,
		})
		return blob
	}

	private getDefaultCaptureRect(): Rect {
		const contentBounds = this.getContentBounds()
		if (!contentBounds) return { x: 0, y: 0, w: 1, h: 1 }
		return {
			x: contentBounds.x - CAPTURE_PADDING,
			y: contentBounds.y - CAPTURE_PADDING,
			w: contentBounds.w + CAPTURE_PADDING * 2,
			h: contentBounds.h + CAPTURE_PADDING * 2,
		}
	}

	private hydrateEditor() {
		this.replaceEditorDocument(this.document, 'ignore')
	}

	private replaceDocument(
		document: CanvasDocument,
		layoutArrowDirections?: ReadonlyMap<string, LayoutDirection | undefined>,
		changedIds: readonly string[] = []
	) {
		this.editor.markHistoryStoppingPoint('canvas.apply_actions')
		this.document = this.replaceEditorDocument(
			document,
			'record',
			layoutArrowDirections,
			new Set(changedIds)
		)
		this.revision += 1
		this.persist()
	}

	private replaceEditorDocument(
		document: CanvasDocument,
		history: 'ignore' | 'record',
		layoutArrowDirections?: ReadonlyMap<string, LayoutDirection | undefined>,
		changedIds = new Set<string>()
	) {
		let replacedDocument = document
		this.isSynchronizing = true
		try {
			this.editor.run(() => {
				this.editor.deleteShapes(this.getSupportedShapes())
				const shapes = document.items.map((item) =>
					canvasItemToShape(
						item,
						document,
						layoutArrowDirections?.get(item.id),
						layoutArrowDirections?.has(item.id) ?? false
					)
				)
				this.editor.createShapes(shapes)
				replacedDocument = layoutArrowDirections
					? this.resizeLayoutFrames(document, changedIds, shapes)
					: document
				this.updateFrameShapes(document, replacedDocument, shapes)
				createArrowBindings(this.editor, replacedDocument, shapes, layoutArrowDirections)
			}, { history })
		} finally {
			this.isSynchronizing = false
		}
		return replacedDocument
	}

	private resizeLayoutFrames(
		document: CanvasDocument,
		changedIds: ReadonlySet<string>,
		shapes: CanvasShape[]
	): CanvasDocument {
		const shapesByPublicId = new Map(
			shapes.flatMap((shape) => {
				const id = getPublicId(shape as TLShape)
				return id ? [[id, shape as TLShape] as const] : []
			})
		)
		const itemById = new Map(document.items.map((item) => [item.id, item]))
		const items = document.items.map((item) => {
			if (item.type !== 'frame' || !changedIds.has(item.id)) return item
			const memberBounds = item.memberIds.flatMap((memberId) => {
				const member = itemById.get(memberId)
				if (!member || (member.type !== 'geo' && member.type !== 'text')) return []
				if (member.type === 'geo') return [{ x: member.x, y: member.y, w: member.w, h: member.h }]
				const shape = shapesByPublicId.get(member.id)
				if (!shape) return []
				const bounds = this.editor.getShapePageBounds(shape)
				return bounds ? [{ x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h }] : []
			})
			const bounds = getPaddedBounds(memberBounds)
			return bounds ? { ...item, ...bounds } : item
		})
		return { items }
	}

	private updateFrameShapes(
		originalDocument: CanvasDocument,
		resizedDocument: CanvasDocument,
		shapes: CanvasShape[]
	) {
		const originalFrames = new Map(
			originalDocument.items.flatMap((item) => (item.type === 'frame' ? [[item.id, item] as const] : []))
		)
		const shapesByPublicId = new Map(
			shapes.flatMap((shape) => {
				const id = getPublicId(shape as TLShape)
				return id ? [[id, shape] as const] : []
			})
		)
		const updates = resizedDocument.items.flatMap((item) => {
			if (item.type !== 'frame') return []
			const original = originalFrames.get(item.id)
			const shape = shapesByPublicId.get(item.id)
			if (!original || !shape || !shape.id || shape.type !== 'frame') return []
			if (original.x === item.x && original.y === item.y && original.w === item.w && original.h === item.h) return []
			return [{ id: shape.id, type: 'frame' as const, x: item.x, y: item.y, props: { ...shape.props, w: item.w, h: item.h } }]
		})
		if (updates.length > 0) this.editor.updateShapes(updates)
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
		const pendingDeleteIds = new Set<string>()
		let isDirectDeleteScheduled = false
		let isDisposed = false
		const flushDirectDelete = () => {
			isDirectDeleteScheduled = false
			if (isDisposed || pendingDeleteIds.size === 0) return
			const itemsById = new Map(this.document.items.map((item) => [item.id, item]))
			const ids = [...pendingDeleteIds].sort(
				(left, right) =>
					Number(itemsById.get(right)?.type === 'arrow') -
					Number(itemsById.get(left)?.type === 'arrow')
			)
			pendingDeleteIds.clear()
			const proposed = proposeCanvasActions(
				this.document,
				ids.map((id) => ({ type: 'delete' as const, id }))
			)
			if ('code' in proposed) return

			this.isSynchronizing = true
			try {
				this.replaceDocument(proposed.document)
			} finally {
				this.isSynchronizing = false
			}
		}
		const removeBeforeDelete = this.editor.sideEffects.registerBeforeDeleteHandler('shape', (shape) => {
			if (this.isSynchronizing || this.isReplayingHistory || !isSupportedShape(shape)) return
			const id = getPublicId(shape)
			if (!id) return false

			pendingDeleteIds.add(id)
			if (!isDirectDeleteScheduled) {
				isDirectDeleteScheduled = true
				queueMicrotask(flushDirectDelete)
			}
			return false
		})

		return () => {
			isDisposed = true
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

function canvasItemToShape(
	item: CanvasItem,
	document: CanvasDocument,
	layoutDirection?: LayoutDirection,
	isLayoutArrow = false
): CanvasShape {
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
		const anchors = getArrowBindingAnchors(from, to, layoutDirection, isLayoutArrow)
	const start = getAnchorPoint(from, anchors.start)
	const end = getAnchorPoint(to, anchors.end)
	const x = Math.min(start.x, end.x)
	const y = Math.min(start.y, end.y)
	return { id: createShapeId(), type: 'arrow' as const, x, y, props: { kind: 'arc', start: { x: start.x - x, y: start.y - y }, end: { x: end.x - x, y: end.y - y }, bend: 0, color: 'black', fill: 'none', dash: 'solid', size: 'm', arrowheadStart: 'none', arrowheadEnd: 'arrow', font: 'draw', richText: toRichText(''), labelPosition: 0.5, labelColor: 'black', scale: 1, elbowMidPoint: 0.5 }, meta } as unknown as CanvasShape
}

function createArrowBindings(
	editor: Editor,
	document: CanvasDocument,
	shapes: CanvasShape[],
	layoutArrowDirections?: ReadonlyMap<string, LayoutDirection | undefined>
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
		const from = getGeometricItem(document, item.fromId)
		const to = getGeometricItem(document, item.toId)
		const anchors = getArrowBindingAnchors(
			from,
			to,
			layoutArrowDirections?.get(item.id),
			layoutArrowDirections?.has(item.id) ?? false
		)
		editor.createBindings([
			{ type: 'arrow', fromId: arrowId, toId: fromId, props: { terminal: 'start', normalizedAnchor: anchors.start, isExact: false, isPrecise: true, snap: 'edge' } },
			{ type: 'arrow', fromId: arrowId, toId, props: { terminal: 'end', normalizedAnchor: anchors.end, isExact: false, isPrecise: true, snap: 'edge' } },
		])
	}
}

function getArrowBindingAnchors(
	from: GeometricCanvasItem,
	to: GeometricCanvasItem,
	layoutDirection?: LayoutDirection,
	isLayoutArrow = false
) {
	if (!isLayoutArrow) return { start: { x: 0.5, y: 0.5 }, end: { x: 0.5, y: 0.5 } }
	if (layoutDirection === 'left-to-right') {
		return { start: { x: 1, y: 0.5 }, end: { x: 0, y: 0.5 } }
	}
	if (layoutDirection === 'top-to-bottom') {
		return { start: { x: 0.5, y: 1 }, end: { x: 0.5, y: 0 } }
	}

	const fromCenter = { x: from.x + from.w / 2, y: from.y + from.h / 2 }
	const toCenter = { x: to.x + to.w / 2, y: to.y + to.h / 2 }
	const deltaX = toCenter.x - fromCenter.x
	const deltaY = toCenter.y - fromCenter.y
	if (Math.abs(deltaX) >= Math.abs(deltaY)) {
		return deltaX >= 0
			? { start: { x: 1, y: 0.5 }, end: { x: 0, y: 0.5 } }
			: { start: { x: 0, y: 0.5 }, end: { x: 1, y: 0.5 } }
	}
	return deltaY >= 0
		? { start: { x: 0.5, y: 1 }, end: { x: 0.5, y: 0 } }
		: { start: { x: 0.5, y: 0 }, end: { x: 0.5, y: 1 } }
}

function getAnchorPoint(item: GeometricCanvasItem, anchor: { x: number; y: number }) {
	return { x: item.x + item.w * anchor.x, y: item.y + item.h * anchor.y }
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

function renderValidationError(message: string, field: string) {
	return { code: 'validation' as const, issues: [{ message, field }] }
}

async function encodeArtifact(blob: Blob, format: string, field: string) {
	if (blob.size > MAX_ENCODED_ARTIFACT_BYTES) {
		return renderValidationError(`${format} must not exceed ${MAX_ENCODED_ARTIFACT_BYTES} bytes`, field)
	}
	const data = await blobToBase64(blob)
	if (data.length > MAX_ENCODED_ARTIFACT_BYTES) {
		return renderValidationError(
			`Encoded ${format} response must not exceed ${MAX_ENCODED_ARTIFACT_BYTES} bytes`,
			field
		)
	}
	return data
}

async function blobToBase64(blob: Blob) {
	const bytes = new Uint8Array(await blob.arrayBuffer())
	let binary = ''
	for (let offset = 0; offset < bytes.length; offset += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
	}
	return btoa(binary)
}

function transparentPngBlob(width: number, height: number) {
	const canvas = document.createElement('canvas')
	canvas.width = width
	canvas.height = height
	return new Promise<Blob>((resolve, reject) =>
		canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not encode transparent PNG'))), 'image/png')
	)
}

function transparentSvgBlob(width: number, height: number) {
	return new Blob(
		[`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"/>`],
		{ type: 'image/svg+xml' }
	)
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

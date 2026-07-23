import {
	Editor,
	TLGeoShape,
	TLShape,
	TLTextShape,
	createShapeId,
	toRichText,
} from 'tldraw'
import {
	CanvasDocument,
	CanvasDocumentSchema,
	CanvasItem,
	GeometricCanvasItem,
	GetContextResultSchema,
	Revision,
	RevisionSchema,
} from '../../shared/canvas-contract'

export const CANVAS_RUNTIME_STORAGE_KEY = 'canvas-runtime-v1'

const SUPPORTED_GEOS = new Set<string>(['rectangle', 'ellipse', 'diamond'])
// Default geo strokes are 3.5 units wide and their draw-style paths extend slightly beyond the model box.
const RENDERED_GEO_INK_MARGIN = 4

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

	dispose() {
		this.removeCanvasItemGuards()
		this.removeStoreListener()
		this.removePageHideListener()
		this.restoreTransactionBoundaries()
		this.flushSynchronization()
	}

	private hydrateEditor() {
		this.isSynchronizing = true
		try {
			const existingPublicIds = new Set(
				this.getSupportedShapes().flatMap((shape) => {
					const publicId = getPublicId(shape)
					return publicId ? [publicId] : []
				})
			)
			this.editor.run(() => {
				this.editor.createShapes(
					this.document.items.flatMap((item) => {
						if (existingPublicIds.has(item.id)) return []
						const shape = canvasItemToShape(item)
						return shape ? [shape] : []
					})
				)
			}, { history: 'ignore' })
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

		return () => {
			removeBeforeCreate()
			removeBeforeChange()
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
			return originalUndo.call(this.editor)
		}
		this.editor.redo = () => {
			this.flushSynchronization()
			return originalRedo.call(this.editor)
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
				items: this.getSupportedShapes().map(shapeToCanvasItem),
			})
			if (JSON.stringify(document) === JSON.stringify(this.document)) return

			this.document = document
			this.revision += 1
			this.storage.setItem(
				CANVAS_RUNTIME_STORAGE_KEY,
				JSON.stringify({ version: 1, revision: this.revision, document: this.document })
			)
		} finally {
			this.isSynchronizing = false
		}
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

function isSupportedShape(shape: TLShape): shape is TLTextShape | TLGeoShape {
	return shape.type === 'text' || (shape.type === 'geo' && SUPPORTED_GEOS.has(shape.props.geo))
}

function canonicalizeNewCanvasItemShape(
	editor: Editor,
	shape: TLTextShape | TLGeoShape
): TLTextShape | TLGeoShape {
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
	shapeBefore: TLTextShape | TLGeoShape,
	shapeAfter: TLTextShape | TLGeoShape
) {
	if (shapeBefore.type !== shapeAfter.type || shapeAfter.rotation !== 0) return false

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

function canonicalizeCanvasItemChange(shape: TLTextShape | TLGeoShape): TLTextShape | TLGeoShape {
	return {
		...shape,
		props: { ...shape.props, richText: toRichText(plainText(shape.props.richText)) },
	} as TLTextShape | TLGeoShape
}

function sameValue(left: unknown, right: unknown) {
	return JSON.stringify(left) === JSON.stringify(right)
}

function shapeToCanvasItem(shape: TLTextShape | TLGeoShape): CanvasItem {
	const id = getPublicId(shape)
	if (!id) throw new Error(`Canvas Runtime shape ${shape.id} has no public ID`)

	if (shape.type === 'text') {
		return { id, type: 'text', x: shape.x, y: shape.y, text: plainText(shape.props.richText) }
	}

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

function canvasItemToShape(item: CanvasItem) {
	const meta = { canvasItemId: item.id }
	if (item.type === 'text') {
		return {
			id: createShapeId(),
			type: 'text' as const,
			x: item.x,
			y: item.y,
			props: { richText: toRichText(item.text), autoSize: true },
			meta,
		}
	}
	if (item.type === 'geo') {
		return {
			id: createShapeId(),
			type: 'geo' as const,
			x: item.x,
			y: item.y,
			props: { geo: item.geo, w: item.w, h: item.h, richText: toRichText(item.text) },
			meta,
		}
	}
	return null
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

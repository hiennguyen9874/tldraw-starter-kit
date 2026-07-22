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
	private readonly removeStoreListener: () => void

	constructor(
		private readonly editor: Editor,
		private readonly storage: CanvasRuntimeStorage = window.localStorage
	) {
		const persisted = loadPersistedCanvasRuntime(storage)
		this.document = persisted.document
		this.revision = persisted.revision

		this.hydrateEditor()
		this.removeStoreListener = editor.store.listen(
			() => this.scheduleSynchronization(),
			{ source: 'user', scope: 'document' }
		)
	}

	getContext() {
		return GetContextResultSchema.parse({
			revision: this.revision,
			document: this.document,
			contentBounds: this.getContentBounds(),
		})
	}

	dispose() {
		this.removeStoreListener()
		if (this.synchronizationTimer) clearTimeout(this.synchronizationTimer)
	}

	private hydrateEditor() {
		this.isSynchronizing = true
		try {
			this.editor.run(() => {
				this.editor.createShapes(
					this.document.items.flatMap((item) => {
						const shape = canvasItemToShape(item)
						return shape ? [shape] : []
					})
				)
			}, { history: 'ignore' })
		} finally {
			this.isSynchronizing = false
		}
	}

	private scheduleSynchronization() {
		if (this.isSynchronizing) return
		if (this.synchronizationTimer) clearTimeout(this.synchronizationTimer)
		this.synchronizationTimer = setTimeout(() => {
			this.synchronizationTimer = undefined
			this.synchronizeFromEditor()
		}, 100)
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

			const supportedShapes = this.editor.getCurrentPageShapes().filter(isSupportedShape)
			const shapesWithoutPublicIds = supportedShapes.filter((shape) => !getPublicId(shape))
			if (shapesWithoutPublicIds.length > 0) {
				this.editor.run(() => {
					this.editor.updateShapes(
						shapesWithoutPublicIds.map((shape) => ({
							id: shape.id,
							type: shape.type,
							meta: { ...shape.meta, canvasItemId: publicIdForShape(shape) },
						}))
					)
				}, { history: 'ignore' })
			}

			const document = CanvasDocumentSchema.parse({
				items: this.editor
					.getCurrentPageShapes()
					.filter(isSupportedShape)
					.map(shapeToCanvasItem),
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

	private getContentBounds() {
		const bounds = this.editor.getShapesPageBounds(
			this.editor.getCurrentPageShapes().filter(isSupportedShape).map((shape) => shape.id)
		)
		return bounds ? { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h } : null
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

function publicIdForShape(shape: TLShape) {
	return `canvas-${shape.id.slice('shape:'.length)}`
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

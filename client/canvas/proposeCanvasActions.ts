import {
	BusinessError,
	CanvasAction,
	CanvasDocument,
	CanvasDocumentSchema,
	CanvasItem,
	GeometricCanvasItem,
	LayoutScope,
} from '../../shared/canvas-contract'

const COMPONENT_GAP = 160
const LAYER_GAP = 120
const ITEM_GAP = 80

export type LayoutDirection = 'left-to-right' | 'top-to-bottom'

interface LayoutPosition {
	x: number
	y: number
}

interface LayoutComponent {
	itemIds: string[]
	edges: LayoutEdge[]
}

interface LayoutEdge {
	fromId: string
	toId: string
}

interface LayoutResult {
	positions: Map<string, LayoutPosition>
	internalArrowIds: string[]
}

export interface ProposedCanvasActions {
	document: CanvasDocument
	changedIds: string[]
	deletedIds: string[]
	layoutArrowDirections?: ReadonlyMap<string, LayoutDirection | undefined>
}

interface ActionSource {
	index: number
	fieldPrefix: string
}

type ItemActionSources = Map<string, ActionSource>

export function proposeCanvasActions(
	document: CanvasDocument,
	actions: CanvasAction[]
): ProposedCanvasActions | BusinessError {
	const items = new Map(document.items.map((item) => [item.id, item]))
	const actionSources = new Map<string, ItemActionSources>()
	const changedIds: string[] = []
	const deletedIds: string[] = []
	const layoutArrowDirections = new Map<string, LayoutDirection | undefined>()
	const deferredLayoutPositions = new Map<string, LayoutPosition>()
	const layoutMovedIds = new Set<string>()
	let hasLayout = false

	for (const [index, action] of actions.entries()) {
		if (action.type === 'layout') {
			hasLayout = true
			const layoutItems = getLayoutItems(items, actions, index + 1, deferredLayoutPositions)
			const layout = layoutCanvasItems(layoutItems, action.scope, action.direction)
			if ('field' in layout) return validation(index, layout.field, layout.message)

			for (const [id, position] of layout.positions) {
				layoutMovedIds.add(id)
				const item = items.get(id)
				if (!item || item.type !== 'geo') {
					deferredLayoutPositions.set(id, position)
					continue
				}
				items.set(id, { ...item, ...position })
				addUnique(changedIds, id)
			}
			const internalArrowIds = new Set(layout.internalArrowIds)
			resizeAffectedFrames(items, layout.positions.keys(), changedIds)
			for (const item of layoutItems.values()) {
				if (
					item.type !== 'arrow' ||
					(!layout.positions.has(item.fromId) && !layout.positions.has(item.toId))
				) continue
				if (items.has(item.id)) addUnique(changedIds, item.id)
				layoutArrowDirections.set(
					item.id,
					internalArrowIds.has(item.id) ? action.direction : undefined
				)
			}
			continue
		}

		if (action.type === 'create') {
			if (items.has(action.item.id)) {
				return validation(index, 'item.id', `Canvas Item ID "${action.item.id}" already exists`)
			}
			const position = deferredLayoutPositions.get(action.item.id)
			const item =
				action.item.type === 'geo' && position ? { ...action.item, ...position } : action.item
			items.set(item.id, item)
			deferredLayoutPositions.delete(item.id)
			actionSources.set(
				item.id,
				new Map(Object.keys(item).map((field) => [field, { index, fieldPrefix: 'item' }]))
			)
			addUnique(changedIds, item.id)
			continue
		}

		const item = items.get(action.id)
		if (!item) return validation(index, 'id', `Canvas Item "${action.id}" was not found`)

		if (action.type === 'update') {
			if (item.type !== action.patch.type) {
				return validation(index, 'patch.type', 'A Canvas Item patch must match the existing Canvas Item type')
			}
			items.set(action.id, { ...item, ...action.patch } as CanvasItem)
			const itemSources = new Map(actionSources.get(action.id))
			for (const field of Object.keys(action.patch)) {
				itemSources.set(field, { index, fieldPrefix: 'patch' })
			}
			actionSources.set(action.id, itemSources)
			addUnique(changedIds, action.id)
			continue
		}

		removeItem(action.id, items, changedIds, deletedIds, actionSources, index)
	}

	resizeAffectedFrames(items, layoutMovedIds, changedIds)

	const parsed = CanvasDocumentSchema.safeParse({ items: [...items.values()] })
	if (!parsed.success) {
		const firstIssue = parsed.error.issues
			.map((issue) => {
				const itemIndex = issue.path[0] === 'items' && typeof issue.path[1] === 'number' ? issue.path[1] : -1
				const item = parsed.error.issues.length > 0 && itemIndex >= 0 ? [...items.values()][itemIndex] : undefined
				const issueField = typeof issue.path[2] === 'string' ? issue.path[2] : undefined
				const itemSources = item ? actionSources.get(item.id) : undefined
				const source = getActionSource(itemSources, issueField)
				return {
					index: source?.index ?? actions.length,
					field: [source?.fieldPrefix, ...issue.path.slice(2)].filter(Boolean).join('.'),
					message: issue.message,
				}
			})
			.sort((left, right) => left.index - right.index)[0]
		return validation(firstIssue.index, firstIssue.field || 'document', firstIssue.message)
	}

	return {
		document: parsed.data,
		changedIds,
		deletedIds,
		...(hasLayout ? { layoutArrowDirections } : {}),
	}
}

function getLayoutItems(
	items: Map<string, CanvasItem>,
	actions: CanvasAction[],
	startIndex: number,
	deferredLayoutPositions: ReadonlyMap<string, LayoutPosition>
) {
	const layoutItems = new Map(items)
	for (let index = startIndex; index < actions.length; index++) {
		const action = actions[index]
		if (action.type !== 'create' || layoutItems.has(action.item.id)) continue
		layoutItems.set(action.item.id, action.item)
	}
	for (const [id, position] of deferredLayoutPositions) {
		const item = layoutItems.get(id)
		if (item?.type === 'geo') layoutItems.set(id, { ...item, ...position })
	}
	return layoutItems
}

function layoutCanvasItems(
	items: Map<string, CanvasItem>,
	scope: LayoutScope,
	direction: LayoutDirection
): LayoutResult | { field: string; message: string } {
	const scopedItems = resolveLayoutScope(items, scope)
	if ('field' in scopedItems) return scopedItems

	const previousTopLeft = {
		x: Math.min(...scopedItems.map((item) => item.x)),
		y: Math.min(...scopedItems.map((item) => item.y)),
	}
	const itemIds = new Set(scopedItems.map((item) => item.id))
	const edges = [...items.values()].flatMap((item) =>
		item.type === 'arrow' && itemIds.has(item.fromId) && itemIds.has(item.toId)
			? [{ id: item.id, fromId: item.fromId, toId: item.toId }]
			: []
	)
	const positions = new Map<string, LayoutPosition>()
	let crossOffset = 0

	for (const component of getLayoutComponents(scopedItems, edges)) {
		const componentLayout = layoutComponent(component, items, direction)
		for (const [id, position] of componentLayout.positions) {
			positions.set(id, {
				x: direction === 'left-to-right' ? position.x : position.x + crossOffset,
				y: direction === 'left-to-right' ? position.y + crossOffset : position.y,
			})
		}
		crossOffset += componentLayout.crossSize + COMPONENT_GAP
	}

	const laidOutTopLeft = {
		x: Math.min(...positions.values().map((position) => position.x)),
		y: Math.min(...positions.values().map((position) => position.y)),
	}
	for (const position of positions.values()) {
		position.x += previousTopLeft.x - laidOutTopLeft.x
		position.y += previousTopLeft.y - laidOutTopLeft.y
	}

	return { positions, internalArrowIds: edges.map((edge) => edge.id) }
}

function resolveLayoutScope(
	items: Map<string, CanvasItem>,
	scope: LayoutScope
): GeometricCanvasItem[] | { field: string; message: string } {
	if (scope.type === 'all') {
		const geometricItems = [...items.values()].filter(
			(item): item is GeometricCanvasItem => item.type === 'geo'
		)
		return geometricItems.length > 0
			? geometricItems
			: { field: 'scope', message: 'Auto-layout scope must contain at least one geometric Canvas Item' }
	}

	if (scope.type === 'frame') {
		const frame = items.get(scope.frameId)
		if (!frame || frame.type !== 'frame') {
			return { field: 'scope.frameId', message: `Canvas Item "${scope.frameId}" is not a frame` }
		}
		const geometricItems = frame.memberIds.flatMap((id) => {
			const item = items.get(id)
			return item?.type === 'geo' ? [item] : []
		})
		return geometricItems.length > 0
			? geometricItems
			: { field: 'scope', message: 'Auto-layout scope must contain at least one geometric Canvas Item' }
	}

	const seenIds = new Set<string>()
	const geometricItems: GeometricCanvasItem[] = []
	for (const [index, id] of scope.itemIds.entries()) {
		if (seenIds.has(id)) {
			return {
				field: `scope.itemIds.${index}`,
				message: `Canvas Item ID "${id}" appears more than once in the Auto-layout scope`,
			}
		}
		seenIds.add(id)
		const item = items.get(id)
		if (!item) return { field: `scope.itemIds.${index}`, message: `Canvas Item "${id}" was not found` }
		if (item.type !== 'geo') {
			return { field: `scope.itemIds.${index}`, message: `Canvas Item "${id}" must be geometric to be laid out` }
		}
		geometricItems.push(item)
	}
	return geometricItems.length > 0
		? geometricItems
		: { field: 'scope', message: 'Auto-layout scope must contain at least one geometric Canvas Item' }
}

function getLayoutComponents(
	items: GeometricCanvasItem[],
	edges: Array<LayoutEdge & { id: string }>
): LayoutComponent[] {
	const neighbors = new Map(items.map((item) => [item.id, new Set<string>()]))
	for (const edge of edges) {
		neighbors.get(edge.fromId)?.add(edge.toId)
		neighbors.get(edge.toId)?.add(edge.fromId)
	}

	const remaining = new Set(items.map((item) => item.id))
	const components: LayoutComponent[] = []
	while (remaining.size > 0) {
		const firstId = [...remaining].sort(compareIds)[0]
		const componentIds = new Set<string>()
		const pending = [firstId]
		remaining.delete(firstId)
		while (pending.length > 0) {
			const id = pending.pop()
			if (!id) continue
			componentIds.add(id)
			for (const neighbor of neighbors.get(id) ?? []) {
				if (remaining.delete(neighbor)) pending.push(neighbor)
			}
		}
		components.push({
			itemIds: [...componentIds].sort(compareIds),
			edges: edges
				.filter((edge) => componentIds.has(edge.fromId) && componentIds.has(edge.toId))
				.map(({ fromId, toId }) => ({ fromId, toId })),
		})
	}
	return components
}

function layoutComponent(
	component: LayoutComponent,
	items: Map<string, CanvasItem>,
	direction: LayoutDirection
) {
	const layers = getLayers(component)
	const positions = new Map<string, LayoutPosition>()
	let flowOffset = 0
	let crossSize = 0

	for (const layer of layers) {
		let crossOffset = 0
		let flowSize = 0
		for (const id of layer) {
			const item = items.get(id)
			if (!item || item.type !== 'geo') continue
			positions.set(id, {
				x: direction === 'left-to-right' ? flowOffset : crossOffset,
				y: direction === 'left-to-right' ? crossOffset : flowOffset,
			})
			crossOffset += (direction === 'left-to-right' ? item.h : item.w) + ITEM_GAP
			flowSize = Math.max(flowSize, direction === 'left-to-right' ? item.w : item.h)
		}
		crossSize = Math.max(crossSize, Math.max(0, crossOffset - ITEM_GAP))
		flowOffset += flowSize + LAYER_GAP
	}

	return { positions, crossSize }
}

function getLayers(component: LayoutComponent) {
	const remaining = new Set(component.itemIds)
	let remainingEdges = [...component.edges]
	let dagEdges = [...component.edges]
	const topologicalOrder: string[] = []

	while (remaining.size > 0) {
		let zeroInDegree = [...remaining]
			.filter((id) => !remainingEdges.some((edge) => edge.toId === id && remaining.has(edge.fromId)))
			.sort(compareIds)
		if (zeroInDegree.length === 0) {
			const cycleBreakId = [...remaining].sort(compareIds)[0]
			remainingEdges = remainingEdges.filter(
				(edge) => edge.toId !== cycleBreakId || !remaining.has(edge.fromId)
			)
			dagEdges = dagEdges.filter(
				(edge) => edge.toId !== cycleBreakId || !remaining.has(edge.fromId)
			)
			zeroInDegree = [cycleBreakId]
		}
		const nextId = zeroInDegree[0]
		topologicalOrder.push(nextId)
		remaining.delete(nextId)
		remainingEdges = remainingEdges.filter((edge) => edge.fromId !== nextId)
	}

	const layersById = new Map(component.itemIds.map((id) => [id, 0]))
	for (const id of topologicalOrder) {
		const layer = Math.max(
			0,
			...dagEdges
				.filter((edge) => edge.toId === id)
				.map((edge) => (layersById.get(edge.fromId) ?? 0) + 1)
		)
		layersById.set(id, layer)
	}
	const layers = new Map<number, string[]>()
	for (const [id, layer] of layersById) {
		const ids = layers.get(layer) ?? []
		ids.push(id)
		layers.set(layer, ids)
	}
	return [...layers.entries()]
		.sort(([left], [right]) => left - right)
		.map(([, ids]) => ids.sort(compareIds))
}

export interface CanvasBounds {
	x: number
	y: number
	w: number
	h: number
}

export function getPaddedBounds(bounds: Iterable<CanvasBounds>, padding = ITEM_GAP): CanvasBounds | null {
	const members = [...bounds]
	if (members.length === 0) return null
	const minX = Math.min(...members.map((member) => member.x))
	const minY = Math.min(...members.map((member) => member.y))
	const maxX = Math.max(...members.map((member) => member.x + member.w))
	const maxY = Math.max(...members.map((member) => member.y + member.h))
	return {
		x: minX - padding,
		y: minY - padding,
		w: maxX - minX + padding * 2,
		h: maxY - minY + padding * 2,
	}
}

function resizeAffectedFrames(
	items: Map<string, CanvasItem>,
	movedIds: Iterable<string>,
	changedIds: string[]
) {
	const moved = new Set(movedIds)
	for (const frame of items.values()) {
		if (frame.type !== 'frame' || !frame.memberIds.some((id) => moved.has(id))) continue
		const bounds = getPaddedBounds(
			frame.memberIds.flatMap((id) => {
				const item = items.get(id)
				if (!item || (item.type !== 'geo' && item.type !== 'text')) return []
				return [{ x: item.x, y: item.y, w: item.type === 'geo' ? item.w : 0, h: item.type === 'geo' ? item.h : 0 }]
			})
		)
		if (!bounds) continue
		items.set(frame.id, { ...frame, ...bounds })
		addUnique(changedIds, frame.id)
	}
}

function compareIds(left: string, right: string) {
	if (left === right) return 0
	return left < right ? -1 : 1
}

function removeItem(
	id: string,
	items: Map<string, CanvasItem>,
	changedIds: string[],
	deletedIds: string[],
	actionSources: Map<string, ItemActionSources>,
	actionIndex: number
) {
	items.delete(id)
	actionSources.delete(id)
	const changedIndex = changedIds.indexOf(id)
	if (changedIndex >= 0) changedIds.splice(changedIndex, 1)
	addUnique(deletedIds, id)

	for (const item of [...items.values()]) {
		if (item.type === 'arrow' && (item.fromId === id || item.toId === id)) {
			removeItem(item.id, items, changedIds, deletedIds, actionSources, actionIndex)
		} else if (item.type === 'frame' && item.memberIds.includes(id)) {
			items.set(item.id, { ...item, memberIds: item.memberIds.filter((memberId) => memberId !== id) })
			const itemSources = new Map(actionSources.get(item.id))
			itemSources.set('memberIds', { index: actionIndex, fieldPrefix: 'id' })
			actionSources.set(item.id, itemSources)
			addUnique(changedIds, item.id)
		}
	}
}

function getActionSource(
	itemSources: ItemActionSources | undefined,
	field: string | undefined
): ActionSource | undefined {
	if (!itemSources) return undefined
	if (field && itemSources.has(field)) return itemSources.get(field)
	return [...itemSources.values()].sort((left, right) => left.index - right.index)[0]
}

function addUnique(ids: string[], id: string) {
	if (!ids.includes(id)) ids.push(id)
}

function validation(actionIndex: number, field: string, message: string): BusinessError {
	return { code: 'validation', issues: [{ actionIndex, field, message }] }
}

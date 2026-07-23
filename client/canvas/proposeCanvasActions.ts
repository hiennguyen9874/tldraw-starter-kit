import {
	BusinessError,
	CanvasAction,
	CanvasDocument,
	CanvasDocumentSchema,
	CanvasItem,
} from '../../shared/canvas-contract'

export interface ProposedCanvasActions {
	document: CanvasDocument
	changedIds: string[]
	deletedIds: string[]
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

	for (const [index, action] of actions.entries()) {
		if (action.type === 'layout') return validation(index, 'type', 'Auto-layout is not available yet')

		if (action.type === 'create') {
			if (items.has(action.item.id)) {
				return validation(index, 'item.id', `Canvas Item ID "${action.item.id}" already exists`)
			}
			items.set(action.item.id, action.item)
			actionSources.set(
				action.item.id,
				new Map(Object.keys(action.item).map((field) => [field, { index, fieldPrefix: 'item' }]))
			)
			addUnique(changedIds, action.item.id)
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

	return { document: parsed.data, changedIds, deletedIds }
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

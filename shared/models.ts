export type AgentModelName = string
export type AgentModelProvider = 'openai' | 'anthropic' | 'google'

export interface AgentModelDefinition {
	name: AgentModelName
	id: string
	provider: AgentModelProvider

	// Overrides the default thinking behavior for that provider
	thinking?: boolean
}

export interface AgentModelConfig {
	models: AgentModelDefinition[]
	defaultModelName: AgentModelName
}

const MODEL_PROVIDERS: AgentModelProvider[] = ['openai', 'anthropic', 'google']

/**
 * Parse the model configuration supplied through Worker environment variables.
 */
export function parseAgentModelConfig(
	modelsValue: string | undefined,
	defaultModelName: string | undefined
): AgentModelConfig {
	if (!modelsValue) {
		throw new Error('AGENT_MODELS is required and must be a JSON array')
	}

	let rawModels: unknown
	try {
		rawModels = JSON.parse(modelsValue)
	} catch {
		throw new Error('AGENT_MODELS must be valid JSON')
	}

	if (!Array.isArray(rawModels) || rawModels.length === 0) {
		throw new Error('AGENT_MODELS must be a non-empty JSON array')
	}

	const names = new Set<string>()
	const models = rawModels.map((rawModel, index): AgentModelDefinition => {
		if (!rawModel || typeof rawModel !== 'object') {
			throw new Error(`AGENT_MODELS[${index}] must be an object`)
		}

		const model = rawModel as Record<string, unknown>
		const name = model.name
		const id = model.id
		const provider = model.provider
		const thinking = model.thinking

		if (typeof name !== 'string' || name.length === 0) {
			throw new Error(`AGENT_MODELS[${index}].name must be a non-empty string`)
		}
		if (names.has(name)) {
			throw new Error(`AGENT_MODELS contains duplicate model name: ${name}`)
		}
		if (typeof id !== 'string' || id.length === 0) {
			throw new Error(`AGENT_MODELS[${index}].id must be a non-empty string`)
		}
		if (!MODEL_PROVIDERS.includes(provider as AgentModelProvider)) {
			throw new Error(
				`AGENT_MODELS[${index}].provider must be one of: ${MODEL_PROVIDERS.join(', ')}`
			)
		}
		if (thinking !== undefined && typeof thinking !== 'boolean') {
			throw new Error(`AGENT_MODELS[${index}].thinking must be a boolean`)
		}

		names.add(name)
		return {
			name,
			id,
			provider: provider as AgentModelProvider,
			...(thinking === undefined ? {} : { thinking }),
		}
	})

	if (!defaultModelName) {
		throw new Error('AGENT_DEFAULT_MODEL is required')
	}
	if (!names.has(defaultModelName)) {
		throw new Error(`AGENT_DEFAULT_MODEL is not present in AGENT_MODELS: ${defaultModelName}`)
	}

	return { models, defaultModelName }
}

/**
 * Get the full information about a model from its configured name.
 */
export function getAgentModelDefinition(
	models: AgentModelDefinition[],
	modelName: AgentModelName
): AgentModelDefinition {
	const definition = models.find((model) => model.name === modelName)
	if (!definition) {
		throw new Error(`Model ${modelName} not found in AGENT_MODELS`)
	}
	return definition
}

/**
 * Check if a model name exists in the configured model list.
 */
export function isValidModelName(
	models: AgentModelDefinition[],
	value: string | undefined
): value is AgentModelName {
	return !!value && models.some((model) => model.name === value)
}

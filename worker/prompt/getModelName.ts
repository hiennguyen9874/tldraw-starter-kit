import { AgentModelName } from '../../shared/models'
import { AgentPrompt } from '../../shared/types/AgentPrompt'
import { getPromptPartDefinition } from '../../shared/types/PromptPart'

/**
 * Get the selected model name from a prompt using shared definitions.
 */
export function getModelName(prompt: AgentPrompt, defaultModelName: AgentModelName): AgentModelName {
	for (const part of Object.values(prompt)) {
		const definition = getPromptPartDefinition(part.type)

		// Check if this definition provides a model name
		if (definition.getModelName) {
			const modelName = definition.getModelName(part)
			if (modelName) return modelName
		}
	}

	return defaultModelName
}

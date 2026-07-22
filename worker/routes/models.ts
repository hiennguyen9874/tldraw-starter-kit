import { IRequest } from 'itty-router'
import { parseAgentModelConfig } from '../../shared/models'
import { Environment } from '../environment'

export function models(_request: IRequest, env: Environment): Response {
	const config = parseAgentModelConfig(env.AGENT_MODELS, env.AGENT_DEFAULT_MODEL)

	return Response.json({
		models: config.models,
		defaultModelName: config.defaultModelName,
	})
}

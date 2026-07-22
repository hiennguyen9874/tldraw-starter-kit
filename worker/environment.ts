export interface Environment {
	AGENT_DURABLE_OBJECT: DurableObjectNamespace
	OPENAI_API_KEY: string
	OPENAI_BASE_URL?: string
	ANTHROPIC_API_KEY: string
	GOOGLE_API_KEY: string
	AGENT_MODELS: string
	AGENT_DEFAULT_MODEL: string
}

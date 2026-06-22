import type { ProviderEnv } from "./types.ts";
import { getProviderEnvValue } from "./utils/provider-env.ts";

/**
 * Find configured environment variables that can provide an API key for a provider.
 * Returns the OPENAI_API_KEY env var if set (works as a generic fallback for OpenAI-compatible endpoints).
 */
export function findEnvKeys(_provider: string, env?: ProviderEnv): string[] | undefined {
	const key = getProviderEnvValue("OPENAI_API_KEY", env);
	return key ? ["OPENAI_API_KEY"] : undefined;
}

/**
 * Get API key for provider from environment variables.
 * Uses OPENAI_API_KEY as the universal env var for OpenAI-compatible endpoints.
 */
export function getEnvApiKey(_provider: string, env?: ProviderEnv): string | undefined {
	return getProviderEnvValue("OPENAI_API_KEY", env);
}

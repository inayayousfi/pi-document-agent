import { join } from "node:path";
import { getDocsPath } from "../config.ts";

export function getProviderLoginHelp(): string {
	return ["Configure your provider in models.json. See:", `  ${join(getDocsPath(), "models.md")}`].join("\n");
}

export function formatNoModelsAvailableMessage(): string {
	return `No models available. Add your endpoint to models.json:\n\n${getProviderLoginHelp()}`;
}

export function formatNoModelSelectedMessage(): string {
	return `No model selected.\n\n${getProviderLoginHelp()}\n\nThen use /model to select a model.`;
}

export function formatNoApiKeyFoundMessage(provider: string): string {
	return `No API key found for ${provider}.\n\n${getProviderLoginHelp()}`;
}

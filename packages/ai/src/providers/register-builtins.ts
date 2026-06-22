import { type ApiProvider, clearApiProviders, getApiProvider, registerApiProvider } from "../api-registry.ts";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
} from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import type { OpenAICompletionsOptions } from "./openai-completions.ts";

interface RegisteringProviderModule {
	register(): void;
}

function createLazyLoadErrorMessage<TApi extends Api>(
	model: { api: TApi; provider: string; id: string },
	error: unknown,
): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

async function loadAndRegisterProvider<TApi extends Api>(
	api: TApi,
	loadModule: () => Promise<RegisteringProviderModule>,
) {
	const module = await loadModule();
	module.register();
	const provider = getApiProvider(api);
	if (!provider) {
		throw new Error(`No API provider registered for api: ${api}`);
	}
	return provider;
}

function forwardStream(target: AssistantMessageEventStream, source: AsyncIterable<AssistantMessageEvent>): void {
	(async () => {
		for await (const event of source) {
			target.push(event);
		}
		target.end();
	})();
}

function createLazyStream<TApi extends Api, TOptions extends StreamOptions>(
	api: TApi,
	loadModule: () => Promise<RegisteringProviderModule>,
): StreamFunction<TApi, TOptions> {
	return (model, context, options) => {
		const outer = new AssistantMessageEventStream();

		loadAndRegisterProvider(api, loadModule)
			.then((provider) => {
				const inner = provider.stream(model, context, options);
				forwardStream(outer, inner);
			})
			.catch((error) => {
				const message = createLazyLoadErrorMessage(model, error);
				outer.push({ type: "error", reason: "error", error: message });
				outer.end(message);
			});

		return outer;
	};
}

function createLazySimpleStream<TApi extends Api>(
	api: TApi,
	loadModule: () => Promise<RegisteringProviderModule>,
): StreamFunction<TApi, SimpleStreamOptions> {
	return (model, context, options) => {
		const outer = new AssistantMessageEventStream();

		loadAndRegisterProvider(api, loadModule)
			.then((provider) => {
				const inner = provider.streamSimple(model, context, options);
				forwardStream(outer, inner);
			})
			.catch((error) => {
				const message = createLazyLoadErrorMessage(model, error);
				outer.push({ type: "error", reason: "error", error: message });
				outer.end(message);
			});

		return outer;
	};
}

function createLazyApiProvider<TApi extends Api, TOptions extends StreamOptions>(
	api: TApi,
	loadModule: () => Promise<RegisteringProviderModule>,
): ApiProvider<TApi, TOptions> {
	return {
		api,
		stream: createLazyStream<TApi, TOptions>(api, loadModule),
		streamSimple: createLazySimpleStream(api, loadModule),
	};
}

const openAICompletionsProvider = createLazyApiProvider<"openai-completions", OpenAICompletionsOptions>(
	"openai-completions",
	() => import("./openai-completions.ts"),
);

export const streamOpenAICompletions = openAICompletionsProvider.stream;
export const streamSimpleOpenAICompletions = openAICompletionsProvider.streamSimple;

export function registerBuiltInImagesApiProviders(): void {
	// No built-in images providers.
}

export function registerBuiltInApiProviders(): void {
	registerApiProvider(openAICompletionsProvider);
}

export function resetApiProviders(): void {
	clearApiProviders();
	registerBuiltInApiProviders();
}

registerBuiltInApiProviders();

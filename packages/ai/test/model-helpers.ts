import type { Model } from "../src/types.ts";

const BASE_URLS: Record<string, string> = {
	openai: "https://api.openai.com/v1",
	openrouter: "https://openrouter.ai/api/v1",
	"cloudflare-ai-gateway": "https://gateway.ai.cloudflare.com/v1/account/gateway",
	"cloudflare-workers-ai": "https://api.cloudflare.com/client/v4/ai",
	groq: "https://api.groq.com/openai/v1",
	zai: "https://api.z.ai/v1",
	"zai-coding-cn": "https://api.z.ai/v1",
	"ant-ling": "https://api.ant-ling.com/v1",
	opencode: "https://api.opencode.ai/v1",
	"opencode-go": "https://api.opencode.ai/v1",
	moonshotai: "https://api.moonshot.cn/v1",
	"moonshotai-cn": "https://api.moonshot.cn/v1",
	xiaomi: "https://ai.xiaomi.com/v1",
	"xiaomi-token-plan-cn": "https://ai.xiaomi.com/v1",
	"xiaomi-token-plan-ams": "https://ai-ams.xiaomi.com/v1",
	"xiaomi-token-plan-sgp": "https://ai-sgp.xiaomi.com/v1",
	"kimi-coding": "https://api.moonshot.cn/v1",
	"vercel-ai-gateway": "https://ai-gateway.vercel.sh/v1",
	together: "https://api.together.ai/v1",
	cerebras: "https://api.cerebras.ai/v1",
	xai: "https://api.x.ai/v1",
	deepseek: "https://api.deepseek.com/v1",
	nvidia: "https://integrate.api.nvidia.com/v1",
};

export function makeModel(
	provider: string,
	id: string,
	overrides?: Partial<Model<"openai-completions">>,
): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: BASE_URLS[provider] ?? "https://api.openai.com/v1",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
		...overrides,
	};
}

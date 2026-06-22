/**
 * HTTP mode: Expose a single POST /ask endpoint over HTTP.
 *
 * Wraps the agent session as an HTTP API with OpenAPI documentation.
 * Requests are processed sequentially against a persistent session.
 * Supports streaming responses via Server-Sent Events (Accept: text/event-stream).
 */

import * as http from "node:http";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";

const OPENAPI_SPEC = {
	openapi: "3.1.0",
	info: {
		title: "pi Agent API",
		version: "1.0.0",
		description: "HTTP API exposing the pi coding agent as a single ask endpoint.",
	},
	paths: {
		"/ask": {
			post: {
				summary: "Ask a question",
				description:
					"Send a message to the agent and receive a response. " +
					"Set Accept: text/event-stream for streaming SSE output.",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								required: ["question"],
								properties: {
									question: {
										type: "string",
										description: "The message to send to the agent.",
									},
								},
							},
						},
					},
				},
				responses: {
					"200": {
						description: "Agent response",
						content: {
							"application/json": {
								schema: {
									type: "object",
									properties: {
										answer: { type: "string" },
									},
								},
							},
							"text/event-stream": {
								schema: {
									type: "string",
									description: "SSE stream of agent events as JSON data lines.",
								},
							},
						},
					},
					"400": {
						description: "Bad request (missing or invalid body)",
						content: {
							"application/json": {
								schema: {
									type: "object",
									properties: { error: { type: "string" } },
								},
							},
						},
					},
					"429": {
						description: "Too many requests (agent queue full)",
						content: {
							"application/json": {
								schema: {
									type: "object",
									properties: { error: { type: "string" } },
								},
							},
						},
					},
					"500": {
						description: "Internal server error",
						content: {
							"application/json": {
								schema: {
									type: "object",
									properties: { error: { type: "string" } },
								},
							},
						},
					},
				},
			},
		},
		"/health": {
			get: {
				summary: "Health check",
				responses: {
					"200": {
						description: "Server is healthy",
						content: {
							"application/json": {
								schema: {
									type: "object",
									properties: {
										status: { type: "string", enum: ["ok"] },
									},
								},
							},
						},
					},
				},
			},
		},
		"/openapi.json": {
			get: {
				summary: "OpenAPI specification",
				responses: {
					"200": {
						description: "OpenAPI 3.1 spec",
						content: { "application/json": { schema: { type: "object" } } },
					},
				},
			},
		},
	},
};

function readBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => resolve(body));
		req.on("error", reject);
	});
}

function jsonResponse(res: http.ServerResponse, statusCode: number, body: object): void {
	const payload = JSON.stringify(body);
	res.writeHead(statusCode, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload),
	});
	res.end(payload);
}

export interface HttpModeOptions {
	port: number;
}

export async function runHttpMode(runtimeHost: AgentSessionRuntime, options: HttpModeOptions): Promise<never> {
	const { port } = options;
	const session = runtimeHost.session;

	// Bind extensions in print mode (no TUI)
	await session.bindExtensions({
		mode: "print",
		commandContextActions: {
			waitForIdle: () => session.agent.waitForIdle(),
			newSession: async (newSessionOptions) => runtimeHost.newSession(newSessionOptions),
			fork: async (entryId, forkOptions) => {
				const result = await runtimeHost.fork(entryId, forkOptions);
				return { cancelled: result.cancelled };
			},
			navigateTree: async (targetId, navigateOptions) => {
				const result = await session.navigateTree(targetId, {
					summarize: navigateOptions?.summarize,
					customInstructions: navigateOptions?.customInstructions,
					replaceInstructions: navigateOptions?.replaceInstructions,
					label: navigateOptions?.label,
				});
				return { cancelled: result.cancelled };
			},
			switchSession: async (sessionPath, switchOptions) => {
				return runtimeHost.switchSession(sessionPath, switchOptions);
			},
			reload: async () => {
				await session.reload();
			},
		},
		onError: (err) => {
			console.error(`Extension error (${err.extensionPath}): ${err.error}`);
		},
	});

	// Serialize requests: one prompt at a time, queue size 1
	let busy = false;
	const queue: Array<() => void> = [];
	const MAX_QUEUE = 10;

	function acquireLock(): Promise<void> {
		if (!busy) {
			busy = true;
			return Promise.resolve();
		}
		if (queue.length >= MAX_QUEUE) {
			return Promise.reject(new Error("queue_full"));
		}
		return new Promise((resolve) => queue.push(resolve));
	}

	function releaseLock(): void {
		const next = queue.shift();
		if (next) {
			next();
		} else {
			busy = false;
		}
	}

	const handleAsk = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
		let body: string;
		try {
			body = await readBody(req);
		} catch {
			jsonResponse(res, 400, { error: "Failed to read request body" });
			return;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(body);
		} catch {
			jsonResponse(res, 400, { error: "Invalid JSON body" });
			return;
		}

		if (
			typeof parsed !== "object" ||
			parsed === null ||
			!("question" in parsed) ||
			typeof (parsed as { question: unknown }).question !== "string"
		) {
			jsonResponse(res, 400, { error: 'Body must be JSON object with "question" string field' });
			return;
		}

		const question = (parsed as { question: string }).question.trim();
		if (!question) {
			jsonResponse(res, 400, { error: '"question" must not be empty' });
			return;
		}

		try {
			await acquireLock();
		} catch {
			jsonResponse(res, 429, { error: "Agent is busy, try again later" });
			return;
		}

		const wantsStream = req.headers.accept?.includes("text/event-stream") ?? false;

		if (wantsStream) {
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			});
			res.write(": connected\n\n");

			const unsubscribe = session.subscribe((event) => {
				if (res.writableEnded) return;
				res.write(`data: ${JSON.stringify(event)}\n\n`);
			});

			try {
				await session.prompt(question);
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				if (!res.writableEnded) {
					res.write(`data: ${JSON.stringify({ type: "error", error: message })}\n\n`);
				}
			} finally {
				unsubscribe();
				releaseLock();
				if (!res.writableEnded) {
					res.write("data: [DONE]\n\n");
					res.end();
				}
			}
			return;
		}

		// Non-streaming: wait for prompt completion, return last assistant text
		try {
			await session.prompt(question);

			const messages = session.state.messages;
			const last = messages[messages.length - 1];
			let answer = "";

			if (last?.role === "assistant") {
				const assistantMsg = last as AssistantMessage;
				if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
					jsonResponse(res, 500, { error: assistantMsg.errorMessage ?? `Request ${assistantMsg.stopReason}` });
					return;
				}
				for (const content of assistantMsg.content) {
					if (content.type === "text") {
						answer += content.text;
					}
				}
			}

			jsonResponse(res, 200, { answer });
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			jsonResponse(res, 500, { error: message });
		} finally {
			releaseLock();
		}
	};

	const server = http.createServer((req, res) => {
		const url = req.url ?? "/";
		const method = req.method ?? "GET";

		// CORS headers for browser clients
		res.setHeader("Access-Control-Allow-Origin", "*");
		res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
		res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");

		if (method === "OPTIONS") {
			res.writeHead(204);
			res.end();
			return;
		}

		if (url === "/health" && method === "GET") {
			jsonResponse(res, 200, { status: "ok" });
			return;
		}

		if (url === "/openapi.json" && method === "GET") {
			jsonResponse(res, 200, OPENAPI_SPEC);
			return;
		}

		if (url === "/ask" && method === "POST") {
			void handleAsk(req, res);
			return;
		}

		jsonResponse(res, 404, { error: `Not found: ${method} ${url}` });
	});

	const signalCleanupHandlers: Array<() => void> = [];
	const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];
	if (process.platform !== "win32") {
		signals.push("SIGHUP");
	}

	for (const signal of signals) {
		const handler = () => {
			killTrackedDetachedChildren();
			server.close(() => {
				void runtimeHost.dispose().finally(() => {
					process.exit(signal === "SIGHUP" ? 129 : 143);
				});
			});
		};
		process.on(signal, handler);
		signalCleanupHandlers.push(() => process.off(signal, handler));
	}

	await new Promise<void>((resolve, reject) => {
		server.listen(port, () => resolve());
		server.once("error", reject);
	});

	console.log(`pi HTTP API listening on http://localhost:${port}`);
	console.log(`  POST /ask          — ask a question`);
	console.log(`  GET  /health       — health check`);
	console.log(`  GET  /openapi.json — API spec`);

	return new Promise(() => {});
}

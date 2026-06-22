/**
 * Document Q&A agent with two tools:
 *   ls              — list directory contents
 *   query_document  — extract text from a PDF or XLSX and answer a question via a sub-agent
 *
 * The sub-agent receives the full document text in its system prompt and has no
 * tools of its own — it answers based solely on the document content.
 *
 * Usage (from repo root, after npm install --ignore-scripts):
 *   npx tsx scripts/document-agent.ts                  # interactive REPL
 *   npx tsx scripts/document-agent.ts "your prompt"    # single prompt, then exit
 */

import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { createInterface } from "node:readline";
import { Agent } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import {
	AuthStorage,
	createAgentSession,
	ModelRegistry,
	SessionManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { extractText, getDocumentProxy } from "unpdf";
import * as XLSX from "xlsx";

// ─── Document parsing ─────────────────────────────────────────────────────────

async function parsePdf(filePath: string): Promise<string> {
	const buf = await readFile(filePath);
	const pdf = await getDocumentProxy(new Uint8Array(buf));
	const { text } = await extractText(pdf, { mergePages: true });
	return text;
}

function parseXlsx(filePath: string): string {
	const wb = XLSX.readFile(filePath);
	return wb.SheetNames.map((name) => {
		const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]!);
		return `=== ${name} ===\n${csv}`;
	}).join("\n\n");
}

async function parseDocument(filePath: string): Promise<string> {
	const ext = extname(filePath).toLowerCase();
	if (ext === ".pdf") return parsePdf(filePath);
	if (ext === ".xlsx" || ext === ".xls") return parseXlsx(filePath);
	throw new Error(`Unsupported file type "${ext}". Supported: .pdf, .xlsx, .xls`);
}

// ─── Tool definition ──────────────────────────────────────────────────────────

const queryDocSchema = Type.Object({
	file: Type.String({ description: "Absolute or relative path to a PDF or XLSX file" }),
	question: Type.String({ description: "Question to answer based on the document content" }),
});

function createQueryDocumentTool(
	modelRef: { current: Model<any> | undefined },
	modelRegistry: ModelRegistry,
): ToolDefinition<typeof queryDocSchema> {
	return {
		name: "query_document",
		label: "query_document",
		description:
			"Parse a PDF or XLSX file and answer a question about it. " +
			"Extracts the document text, then delegates to a sub-agent that answers " +
			"using only the document content. Supports .pdf, .xlsx, and .xls files.",
		parameters: queryDocSchema,
		async execute(_toolCallId, { file, question }, signal) {
			const model = modelRef.current;
			if (!model) throw new Error("No model configured");

			const docText = await parseDocument(file);
			if (signal?.aborted) throw new Error("Aborted");

			const auth = await modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) throw new Error(`Authentication failed: ${auth.error}`);

			const subAgent = new Agent({
				initialState: {
					systemPrompt:
						"You are a document analysis assistant. " +
						"Answer the user question using only the content below — do not guess beyond it.\n\n" +
						`<document path="${file}">\n${docText}\n</document>`,
					model,
					tools: [],
				},
				streamFn: (m, ctx, opts) =>
					streamSimple(m, ctx, {
						...opts,
						apiKey: auth.apiKey,
						headers: auth.headers,
					}),
			});

			if (signal) {
				signal.addEventListener("abort", () => subAgent.abort(), { once: true });
			}

			let answer = "";
			let subError: string | undefined;
			subAgent.subscribe((event) => {
				if (event.type === "message_end" && event.message.role === "assistant") {
					const msg = event.message as { role: "assistant"; content: unknown; errorMessage?: string };
					if (msg.errorMessage) {
						subError = msg.errorMessage;
					} else if (Array.isArray(msg.content)) {
						answer = (msg.content as Array<{ type: string; text?: string }>)
							.filter((c) => c.type === "text")
							.map((c) => c.text ?? "")
							.join("");
					}
				}
			});

			await subAgent.prompt(question);
			await subAgent.waitForIdle();

			if (signal?.aborted) throw new Error("Aborted");
			if (subError) throw new Error(`Sub-agent error: ${subError}`);
			return {
				content: [{ type: "text", text: answer }],
				details: { file, question },
			};
		},
	};
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main() {
	const authStorage = AuthStorage.create();
	const modelRegistry = ModelRegistry.create(authStorage);
	const modelRef: { current: Model<any> | undefined } = { current: undefined };

	const { session } = await createAgentSession({
		authStorage,
		modelRegistry,
		tools: ["ls"],
		customTools: [createQueryDocumentTool(modelRef, modelRegistry)],
		sessionManager: SessionManager.inMemory(),
	});

	// Keep modelRef current so the sub-agent always uses the active model.
	modelRef.current = session.model;
	session.subscribe(() => {
		modelRef.current = session.model;
	});

	// Stream assistant text to stdout; note tool invocations to stderr.
	session.subscribe((event) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			process.stdout.write(event.assistantMessageEvent.delta);
		}
		if (event.type === "tool_execution_start") {
			process.stderr.write(`[${event.toolName}] ...\n`);
		}
		if (event.type === "agent_end") {
			process.stdout.write("\n");
		}
	});

	const argPrompt = process.argv.slice(2).join(" ").trim();
	if (argPrompt) {
		await session.prompt(argPrompt);
		session.dispose();
		return;
	}

	// Interactive REPL
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	process.stderr.write('Document agent ready (tools: ls, query_document). Type "exit" to quit.\n');

	const next = () => {
		rl.question("You: ", async (line) => {
			const text = line.trim();
			if (!text || text === "exit" || text === "quit") {
				rl.close();
				session.dispose();
				return;
			}
			await session.prompt(text);
			next();
		});
	};
	next();
}

main().catch((err) => {
	process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(1);
});

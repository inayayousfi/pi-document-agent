/**
 * Document Q&A extension.
 *
 * Adds a `query_document` tool that parses a PDF or XLSX file and answers
 * a question about it using a sub-agent with no additional tools.
 *
 * Setup:
 *   cd packages/coding-agent/examples/extensions/document-agent
 *   npm install --ignore-scripts
 *
 * Usage:
 *   pi -e /path/to/pi/packages/coding-agent/examples/extensions/document-agent
 */

import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { extractText, getDocumentProxy } from "unpdf";
import * as XLSX from "xlsx";

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

const queryDocSchema = Type.Object({
	file: Type.String({ description: "Absolute or relative path to a PDF or XLSX file" }),
	question: Type.String({ description: "Question to answer based on the document content" }),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "query_document",
		label: "query_document",
		description:
			"Parse a PDF or XLSX file and answer a question about it. " +
			"Extracts the document text, then delegates to a sub-agent that answers " +
			"using only the document content. Supports .pdf, .xlsx, and .xls files.",
		parameters: queryDocSchema,
		async execute(_toolCallId, { file, question }, signal, _onUpdate, ctx) {
			const model = ctx.model;
			if (!model) throw new Error("No model configured");

			const docText = await parseDocument(file);
			if (signal?.aborted) throw new Error("Aborted");

			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
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
				streamFn: (m, c, opts) =>
					streamSimple(m, c, {
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
	});
}

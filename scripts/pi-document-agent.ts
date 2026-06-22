#!/usr/bin/env -S npx tsx
/**
 * PI Document Agent — full TUI restricted to document Q&A tools.
 *
 * Main-agent tools:
 *   ls              — list directory contents
 *   query_document  — open a document and delegate a question to a sub-agent
 *
 * Sub-agent tools (scoped to the queried document):
 *   pdf_info        — page count of the PDF
 *   pdf_read_pages  — extract text from a page range (1-indexed)
 *   xlsx_list_sheets — list sheet names in the workbook
 *   xlsx_read_sheet  — read a sheet as CSV
 *
 * Usage (from repo root, after npm install --ignore-scripts):
 *   npx tsx scripts/pi-document-agent.ts [pi args...]
 *
 * Or make executable and run directly:
 *   chmod +x scripts/pi-document-agent.ts
 *   ./scripts/pi-document-agent.ts
 */

import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai";
import { main } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { extractText, getDocumentProxy } from "unpdf";
import * as XLSX from "xlsx";

process.title = "pi-document-agent";
process.emitWarning = (() => {}) as typeof process.emitWarning;

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Sanitize a file path produced by the model: strip surrounding quotes, decode
// %20 and common shell escapes, collapse backslash-space sequences.
function sanitizeFilePath(raw: string): string {
	return raw
		.trim()
		.replace(/^['"]|['"]$/g, "")
		.replace(/%20/g, " ")
		.replace(/\\(.)/g, "$1");
}

// Suppress PDF.js "Warning: TT: undefined function" lines written to stderr.
function suppressPdfJsWarnings<T>(fn: () => Promise<T>): Promise<T> {
	const originalWrite = process.stderr.write.bind(process.stderr);
	process.stderr.write = (chunk: unknown, ...rest: unknown[]) => {
		const str = typeof chunk === "string" ? chunk : String(chunk);
		if (str.includes("TT: undefined function")) return true;
		return (originalWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
	};
	return fn().finally(() => {
		process.stderr.write = originalWrite;
	});
}

// ─── xlsx compat ──────────────────────────────────────────────────────────────

// xlsx uses CJS exports; in ESM the functions may land on .default.
function getXlsx(): typeof XLSX {
	return (XLSX as unknown as { default?: typeof XLSX }).default ?? XLSX;
}

// ─── PDF helpers ──────────────────────────────────────────────────────────────

async function openPdf(filePath: string) {
	const buf = await readFile(filePath);
	return getDocumentProxy(new Uint8Array(buf));
}

async function getPdfPages(filePath: string): Promise<string[]> {
	return suppressPdfJsWarnings(async () => {
		const pdf = await openPdf(filePath);
		const { text } = await extractText(pdf, { mergePages: false });
		return text as unknown as string[];
	});
}

// Convert a single PDF page's raw text into markdown.
// Heuristic: short all-caps lines or title-case lines (< 80 chars) become headings.
function pdfPageToMarkdown(rawText: string, pageNum: number): string {
	const lines = rawText.split("\n");
	const out: string[] = [`## Page ${pageNum}\n`];

	for (const raw of lines) {
		const line = raw.trimEnd();
		if (!line.trim()) {
			out.push("");
			continue;
		}
		const trimmed = line.trim();
		const isShort = trimmed.length > 0 && trimmed.length < 80;
		const isAllCaps = isShort && trimmed === trimmed.toUpperCase() && /[A-Z]{2}/.test(trimmed);
		// Title-case: most words start with an uppercase letter and no period at end
		const isTitleCase =
			isShort &&
			!trimmed.endsWith(".") &&
			trimmed.split(/\s+/).filter((w) => w.length > 3).every((w) => /^[A-Z]/.test(w));

		if (isAllCaps) {
			out.push(`### ${trimmed}`);
		} else if (isTitleCase) {
			out.push(`#### ${trimmed}`);
		} else {
			out.push(line);
		}
	}

	return out.join("\n");
}

// ─── Excel helpers ────────────────────────────────────────────────────────────

function xlsxSheetToMarkdown(ws: XLSX.WorkSheet): string {
	type Row = (string | number | boolean | null | undefined)[];
	const rows = getXlsx().utils.sheet_to_json<Row>(ws, { header: 1 }) as Row[];
	if (rows.length === 0) return "_Empty sheet_";

	const colCount = Math.max(...rows.map((r) => r.length));

	const cell = (v: unknown) =>
		String(v ?? "")
			.replace(/\|/g, "\\|")
			.replace(/\r?\n/g, " ")
			.trim();

	const mdRow = (row: Row) =>
		"| " + Array.from({ length: colCount }, (_, i) => cell(row[i])).join(" | ") + " |";

	const separator = "| " + Array(colCount).fill("---").join(" | ") + " |";

	return [mdRow(rows[0]!), separator, ...rows.slice(1).map(mdRow)].join("\n");
}

// ─── Sub-agent tool factory ───────────────────────────────────────────────────

function createDocumentTools(filePath: string): AgentTool[] {
	const ext = extname(filePath).toLowerCase();
	const isPdf = ext === ".pdf";
	const isXlsx = ext === ".xlsx" || ext === ".xls";

	const tools: ToolDefinition[] = [];

	if (isPdf) {
		tools.push({
			name: "pdf_info",
			label: "pdf_info",
			description: "Return the total number of pages in the document.",
			parameters: Type.Object({}),
			async execute() {
				const pages = await getPdfPages(filePath);
				return { content: [{ type: "text", text: `Total pages: ${pages.length}` }] };
			},
		});

		tools.push({
			name: "pdf_read_pages",
			label: "pdf_read_pages",
			description:
				"Extract pages start–end (1-indexed, inclusive) as Markdown. " +
				"Headings are inferred from text style. Use pdf_info first to know the page count.",
			parameters: Type.Object({
				start: Type.Integer({ minimum: 1, description: "First page to read (1-indexed)" }),
				end: Type.Integer({ minimum: 1, description: "Last page to read (1-indexed, inclusive)" }),
			}),
			async execute(_id, { start, end }) {
				const pages = await getPdfPages(filePath);
				const slice = pages.slice(start - 1, end);
				if (slice.length === 0) {
					return { content: [{ type: "text", text: `No pages found in range ${start}–${end}.` }] };
				}
				const md = slice.map((p, i) => pdfPageToMarkdown(p, start + i)).join("\n\n---\n\n");
				return { content: [{ type: "text", text: md }] };
			},
		});
	}

	if (isXlsx) {
		tools.push({
			name: "xlsx_list_sheets",
			label: "xlsx_list_sheets",
			description: "List the sheet names in the workbook.",
			parameters: Type.Object({}),
			execute() {
				const wb = getXlsx().readFile(filePath);
				return Promise.resolve({
					content: [{ type: "text", text: wb.SheetNames.join("\n") }],
				});
			},
		});

		tools.push({
			name: "xlsx_read_sheet",
			label: "xlsx_read_sheet",
			description:
				"Read a sheet from the workbook as a Markdown table. Use xlsx_list_sheets first to get sheet names.",
			parameters: Type.Object({
				sheet: Type.String({ description: "Exact sheet name as returned by xlsx_list_sheets" }),
			}),
			execute(_id, { sheet }) {
				const xlsxLib = getXlsx();
				const wb = xlsxLib.readFile(filePath);
				const ws = wb.Sheets[sheet];
				if (!ws) {
					return Promise.resolve({
						content: [
							{
								type: "text",
								text: `Sheet "${sheet}" not found. Available: ${wb.SheetNames.join(", ")}`,
							},
						],
					});
				}
				const md = `## Sheet: ${sheet}\n\n${xlsxSheetToMarkdown(ws)}`;
				return Promise.resolve({ content: [{ type: "text", text: md }] });
			},
		});
	}

	return tools;
}

// ─── Prompts ──────────────────────────────────────────────────────────────────

const DOCUMENT_ONLY_CONSTRAINT =
	"IMPORTANT: Answer exclusively from the document content — never from training knowledge " +
	"or general expertise. If the answer is not in the document, say so explicitly.";

function mainAgentConstraint(files: string[]): string {
	const fileList = files.map((f) => `  - ${f}`).join("\n");
	return (
		`${DOCUMENT_ONLY_CONSTRAINT}\n\n` +
		`## How to call query_document\n\n` +
		`Pass the file path exactly as it appears in ls output — no quoting, no escaping, no %20.\n\n` +
		`Available documents:\n${fileList}\n\n` +
		`Correct examples:\n` +
		files.map((f) => `  query_document(file="${f}", question="…")`).join("\n")
	);
}

function subAgentSystemPrompt(filePath: string, ext: string): string {
	const isPdf = ext === ".pdf";
	const toolDocs = isPdf
		? `- pdf_info()  →  total page count\n` +
			`- pdf_read_pages(start, end)  →  pages start–end as Markdown (headings inferred, 1-indexed)`
		: `- xlsx_list_sheets()  →  list of sheet names\n` +
			`- xlsx_read_sheet(sheet)  →  sheet as a Markdown table`;

	return (
		`You are a document analysis assistant working on: ${filePath}\n\n` +
		`${DOCUMENT_ONLY_CONSTRAINT}\n\n` +
		`Document content is provided to you as Markdown. ` +
		`Use the structure (headings, tables) to locate relevant sections before answering.\n\n` +
		`Tools available to navigate the document:\n${toolDocs}\n\n` +
		`Read only what you need to answer the question. ` +
		`Do not load the entire document if a targeted read suffices.`
	);
}

// ─── Extension factory ────────────────────────────────────────────────────────

function documentAgentExtension(pi: ExtensionAPI) {
	let thinkingLevel: ThinkingLevel = "off";
	pi.on("session_start", () => {
		thinkingLevel = pi.getThinkingLevel();
	});
	pi.on("thinking_level_select", (event) => {
		thinkingLevel = event.level;
	});

	// Inject document-only constraint + tool usage examples into main agent.
	pi.on("before_agent_start", (event) => {
		// Collect files visible in the session cwd for the examples.
		const systemPrompt = `${event.systemPrompt}\n\n${mainAgentConstraint([])}`;
		return { systemPrompt };
	});

	pi.registerTool({
		name: "query_document",
		label: "query_document",
		description:
			"Open a PDF or XLSX file and answer a question about its content using a sub-agent " +
			"that can navigate the document page by page or sheet by sheet. " +
			"Supported formats: .pdf, .xlsx, .xls.",
		promptSnippet: 'query_document(file="report.pdf", question="…")',
		promptGuidelines: [
			"Pass the file path exactly as shown by ls — no quoting, no escaping, no %20 encoding.",
			'Correct: query_document(file="FACTUR-X 1.08 2025 12 04 FR.pdf", question="…")',
			'Wrong:   query_document(file="FACTUR-X%201.08%202025%2012%2004%20FR.pdf", question="…")',
			'Wrong:   query_document(file=\'"FACTUR-X 1.08 2025 12 04 FR.pdf"\', question="…")',
		],
		parameters: Type.Object({
			file: Type.String({ description: "File path exactly as shown by ls — no escaping, no quoting" }),
			question: Type.String({ description: "Question to answer using the document content" }),
		}),
		async execute(_toolCallId, { file, question }, signal, _onUpdate, ctx) {
			const model = ctx.model;
			if (!model) throw new Error("No model configured");

			const resolvedFile = resolve(ctx.cwd, sanitizeFilePath(file));
			const ext = extname(resolvedFile).toLowerCase();
			if (ext !== ".pdf" && ext !== ".xlsx" && ext !== ".xls") {
				throw new Error(`Unsupported file type "${ext}". Supported: .pdf, .xlsx, .xls`);
			}

			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) throw new Error(`Authentication failed: ${auth.error}`);

			const subAgentTools = createDocumentTools(resolvedFile);

			process.stderr.write(
				[
					"[query_document] sub-agent call",
					`  file          : ${resolvedFile}`,
					`  question      : ${question}`,
					`  model         : ${model.id}`,
					`  thinkingLevel : ${thinkingLevel}`,
					`  tools         : ${subAgentTools.map((t) => t.name).join(", ")}`,
					"",
				].join("\n"),
			);

			const subAgent = new Agent({
				initialState: {
					systemPrompt: subAgentSystemPrompt(resolvedFile, ext),
					model,
					thinkingLevel,
					tools: subAgentTools,
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
				details: { file: resolvedFile, question },
			};
		},
	});
}

// ─── Entry point ──────────────────────────────────────────────────────────────

const userArgs = process.argv.slice(2);
main(["--tools", "ls,query_document", "--no-extensions", ...userArgs], {
	extensionFactories: [documentAgentExtension],
}).catch((err) => {
	process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(1);
});

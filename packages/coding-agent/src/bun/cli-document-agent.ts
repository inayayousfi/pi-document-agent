#!/usr/bin/env node
import { APP_NAME } from "../config.ts";
import { configureHttpDispatcher } from "../core/http-dispatcher.ts";
import { main } from "../main.ts";

process.title = APP_NAME;
process.env.PI_CODING_AGENT = "true";
process.emitWarning = (() => {}) as typeof process.emitWarning;

import { restoreSandboxEnv } from "./restore-sandbox-env.ts";

restoreSandboxEnv();

await import("./register-bedrock.ts");

import documentAgentExtension from "../../examples/extensions/document-agent/index.ts";
import type { ExtensionFactory } from "../core/extensions/types.ts";

configureHttpDispatcher();

main(process.argv.slice(2), {
	extensionFactories: [documentAgentExtension as ExtensionFactory],
});

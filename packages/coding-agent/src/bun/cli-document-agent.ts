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

import documentAgentExtension from "../document-agent-extension.ts";

configureHttpDispatcher();

main(process.argv.slice(2), {
	extensionFactories: [documentAgentExtension],
});

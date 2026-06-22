/**
 * Builds pi-document-agent as a self-contained Node.js SEA (Single Executable Application).
 *
 * Steps:
 *   1. Bundle dist/bun/cli-document-agent.js → CJS via esbuild
 *   2. Generate SEA blob via `node --experimental-sea-config`
 *   3. Copy the current node binary
 *   4. Inject the blob via postject
 *   5. (macOS only) Re-sign the binary
 */

import { execSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { platform } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const distDir = join(root, "packages/coding-agent/dist");
const tmpDir = join(distDir, ".sea-tmp");
const bundlePath = join(tmpDir, "bundle.cjs");
const blobPath = join(tmpDir, "sea.blob");
const seaConfigPath = join(tmpDir, "sea-config.json");
const outBinary = join(distDir, "pi-document-agent");

mkdirSync(tmpDir, { recursive: true });

// 1. Bundle to CJS (SEA requires CommonJS)
console.log("Bundling...");
execSync(
	[
		"node node_modules/.bin/esbuild",
		"packages/coding-agent/dist/bun/cli-document-agent.js",
		"--bundle",
		"--platform=node",
		"--format=cjs",
		`--outfile=${bundlePath}`,
		"--external:@silvia-odwyer/photon-node",
	].join(" "),
	{ cwd: root, stdio: "inherit" },
);

// 2. Generate SEA blob
console.log("Generating SEA blob...");
writeFileSync(
	seaConfigPath,
	JSON.stringify({
		main: bundlePath,
		output: blobPath,
		disableExperimentalSEAWarning: true,
	}),
);
execSync(`node --experimental-sea-config ${seaConfigPath}`, { cwd: root, stdio: "inherit" });

// 3. Copy node binary
console.log("Copying node binary...");
copyFileSync(process.execPath, outBinary);
execSync(`chmod +x ${outBinary}`);

// 4. On macOS remove code signature before injecting
if (platform() === "darwin") {
	execSync(`codesign --remove-signature ${outBinary}`, { stdio: "inherit" });
}

// 5. Inject blob
console.log("Injecting SEA blob...");
execSync(
	[
		"node node_modules/.bin/postject",
		outBinary,
		"NODE_SEA_BLOB",
		blobPath,
		"--sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
	].join(" "),
	{ cwd: root, stdio: "inherit" },
);

// 6. On macOS re-sign
if (platform() === "darwin") {
	execSync(`codesign --sign - ${outBinary}`, { stdio: "inherit" });
}

// 7. Clean up temp files
rmSync(tmpDir, { recursive: true });

console.log(`\nBuilt: ${outBinary}`);

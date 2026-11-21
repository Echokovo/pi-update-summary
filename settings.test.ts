import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { TOOL_NAME, readToolConfig } from "./settings.ts";

let agentDir: string;
let previousAgentDir: string | undefined;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "update-summary-"));
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
});

function writeSettings(contents: string): void {
	writeFileSync(join(agentDir, "settings.json"), contents);
}

test("leaves the tool unregistered when no settings file exists", async () => {
	assert.deepEqual(await readToolConfig(), { registerTool: false });
});

test("registers the tool when updateSummary.tool is true", async () => {
	writeSettings(JSON.stringify({ updateSummary: { tool: true } }));
	assert.deepEqual(await readToolConfig(), { registerTool: true });
});

test("still reads the legacy updateChangelog block", async () => {
	writeSettings(JSON.stringify({ updateChangelog: { tool: true } }));
	assert.deepEqual(await readToolConfig(), { registerTool: true });
});

test("prefers updateSummary over the legacy updateChangelog block", async () => {
	writeSettings(JSON.stringify({ updateSummary: { tool: true }, updateChangelog: { tool: false } }));
	assert.deepEqual(await readToolConfig(), { registerTool: true });
});

test("registers the tool when updateSummary.tool is \"always\"", async () => {
	writeSettings(JSON.stringify({ updateSummary: { tool: "always" } }));
	assert.deepEqual(await readToolConfig(), { registerTool: true });
});

for (const value of [false, "auto", "off"]) {
	test(`leaves the tool unregistered when updateSummary.tool is ${JSON.stringify(value)}`, async () => {
		writeSettings(JSON.stringify({ updateSummary: { tool: value } }));
		assert.deepEqual(await readToolConfig(), { registerTool: false });
	});
}

test("ignores unrelated settings", async () => {
	writeSettings(JSON.stringify({ defaultProvider: "anthropic", packages: ["@mblarsen/pi-task-ui"] }));
	assert.deepEqual(await readToolConfig(), { registerTool: false });
});

test("reports and leaves the tool unregistered when updateSummary is not an object", async () => {
	writeSettings(JSON.stringify({ updateSummary: "off" }));
	const config = await readToolConfig();
	assert.equal(config.registerTool, false);
	assert.match(config.warning ?? "", /"updateSummary" must be an object/);
});

test("reports and leaves the tool unregistered when updateSummary.tool has an unknown value", async () => {
	writeSettings(JSON.stringify({ updateSummary: { tool: "yes" } }));
	const config = await readToolConfig();
	assert.equal(config.registerTool, false);
	assert.match(config.warning ?? "", /"updateSummary\.tool" must be true/);
	assert.match(config.warning ?? "", new RegExp(TOOL_NAME));
});

test("reports and leaves the tool unregistered when settings.json is not valid JSON", async () => {
	writeSettings("{ not json");
	const config = await readToolConfig();
	assert.equal(config.registerTool, false);
	assert.match(config.warning ?? "", /not valid JSON/);
});

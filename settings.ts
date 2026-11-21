import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Pi resolves its config directory from PI_CODING_AGENT_DIR. Using Pi's own helper keeps this
// extension pointed at the same settings.json Pi reads, including custom configDir and ~ paths.
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const TOOL_NAME = "package_changelog";

const SETTINGS_KEY = "updateSummary";
/** Older configs used the extension's previous name; still read so the opt-in is not silently lost. */
const LEGACY_SETTINGS_KEY = "updateChangelog";

export function getSettingsPath(): string {
  return join(getAgentDir(), "settings.json");
}

export interface ToolConfig {
  /**
   * Whether `package_changelog` is registered at all. An unregistered tool costs nothing per
   * request, so the default is false and `/update-summary` covers the same ground.
   */
  registerTool: boolean;
  warning?: string;
}

const ENABLED_VALUES = new Set<unknown>([true, "always"]);
const DISABLED_VALUES = new Set<unknown>([false, "auto", "off"]);

/**
 * Reads `updateSummary.tool` from settings.json, falling back to the legacy `updateChangelog` block.
 *
 * A value that is none of the accepted spellings is reported instead of guessed at: silently
 * ignoring it would leave the reader unsure whether the tool is on or off.
 */
export async function readToolConfig(): Promise<ToolConfig> {
  let raw: string;
  try {
    raw = await readFile(getSettingsPath(), "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { registerTool: false };
    return { registerTool: false, warning: `update-summary: cannot read settings.json (${(err as Error).message}); ${TOOL_NAME} stays unregistered.` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { registerTool: false, warning: `update-summary: settings.json is not valid JSON (${(err as Error).message}); ${TOOL_NAME} stays unregistered.` };
  }

  const root = parsed as Record<string, unknown> | null;
  let key = SETTINGS_KEY;
  let block = root?.[key];
  if (block === undefined || block === null) {
    key = LEGACY_SETTINGS_KEY;
    block = root?.[key];
  }
  if (block === undefined || block === null) return { registerTool: false };
  if (typeof block !== "object" || Array.isArray(block)) {
    return { registerTool: false, warning: `update-summary: "${key}" must be an object such as { "tool": true }; ${TOOL_NAME} stays unregistered.` };
  }

  const tool = (block as Record<string, unknown>).tool;
  if (tool === undefined) return { registerTool: false };
  if (ENABLED_VALUES.has(tool)) return { registerTool: true };
  if (DISABLED_VALUES.has(tool)) return { registerTool: false };

  return {
    registerTool: false,
    warning: `update-summary: "${key}.tool" must be true (or "always") to register ${TOOL_NAME}, or false (or "auto"/"off") to leave it unregistered.`,
  };
}

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Optional project configuration, read from `valta.config.json`.
 *
 *   {
 *     "sdk_default_retries": 3,
 *     "custom_endpoint_costs": [
 *       { "match_url": "://proxy-scraping.com", "cost_per_call": 0.005 }
 *     ]
 *   }
 *
 * Everything is optional. Without `sdk_default_retries` the scanner applies a
 * conservative default multiplier of DEFAULT_SDK_RETRIES (the OpenAI and
 * Anthropic SDKs both retry failed requests up to 2 times by default) and says
 * so in its output.
 */
export interface CustomEndpointCost {
  /** Substring matched against the URL passed to a call (e.g. "://proxy-scraping.com"). */
  match_url: string;
  /** Flat USD cost charged every time a matching call runs. */
  cost_per_call: number;
}

export interface ValtaConfig {
  /**
   * Multiplier applied to the token cost of every LLM call, to account for an
   * SDK silently re-sending failed requests. This is the EFFECTIVE value:
   * the configured number, or DEFAULT_SDK_RETRIES when none was configured.
   */
  sdk_default_retries: number;
  /** True only when the user set `sdk_default_retries` themselves. */
  retries_from_config: boolean;
  custom_endpoint_costs: CustomEndpointCost[];
  /**
   * Average size, in tokens, of one message appended to a conversation history
   * per loop iteration. Only used by the quadratic history-growth estimate.
   * When omitted, the estimate uses the assumed output size of one call.
   */
  average_message_tokens?: number;
}

export const CONFIG_FILE_NAME = "valta.config.json";

/** Standard OpenAI / Anthropic SDK default retry count, used when the user configures none. */
export const DEFAULT_SDK_RETRIES = 2;

export const DEFAULT_CONFIG: ValtaConfig = {
  sdk_default_retries: DEFAULT_SDK_RETRIES,
  retries_from_config: false,
  custom_endpoint_costs: [],
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validates already-parsed JSON. Throws ConfigError with a message naming the bad field. */
export function parseConfig(raw: unknown, source = CONFIG_FILE_NAME): ValtaConfig {
  if (!isPlainObject(raw)) {
    throw new ConfigError(`${source}: expected a JSON object at the top level.`);
  }

  const config: ValtaConfig = { ...DEFAULT_CONFIG, custom_endpoint_costs: [] };

  if (raw.sdk_default_retries !== undefined) {
    const n = raw.sdk_default_retries;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
      throw new ConfigError(`${source}: "sdk_default_retries" must be a whole number >= 1.`);
    }
    config.sdk_default_retries = n;
    config.retries_from_config = true;
  }

  if (raw.average_message_tokens !== undefined) {
    const n = raw.average_message_tokens;
    if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
      throw new ConfigError(`${source}: "average_message_tokens" must be a positive number.`);
    }
    config.average_message_tokens = n;
  }

  if (raw.custom_endpoint_costs !== undefined) {
    if (!Array.isArray(raw.custom_endpoint_costs)) {
      throw new ConfigError(`${source}: "custom_endpoint_costs" must be an array.`);
    }
    raw.custom_endpoint_costs.forEach((entry, i) => {
      const where = `${source}: custom_endpoint_costs[${i}]`;
      if (!isPlainObject(entry)) {
        throw new ConfigError(`${where} must be an object with "match_url" and "cost_per_call".`);
      }
      const { match_url, cost_per_call } = entry;
      if (typeof match_url !== "string" || match_url.length === 0) {
        throw new ConfigError(`${where}.match_url must be a non-empty string.`);
      }
      if (typeof cost_per_call !== "number" || !Number.isFinite(cost_per_call) || cost_per_call < 0) {
        throw new ConfigError(`${where}.cost_per_call must be a number >= 0.`);
      }
      config.custom_endpoint_costs.push({ match_url, cost_per_call });
    });
  }

  return config;
}

export interface LoadedConfig {
  config: ValtaConfig;
  /** Absolute path of the file that was read, or null when none was found. */
  path: string | null;
}

/**
 * Looks for `valta.config.json` in each directory given, in order, and uses
 * the first one found. Pass the scan target first and the current working
 * directory second so `valta-leak ./src` still picks up a config that sits in
 * the project root. An explicit `explicitPath` skips the search and must exist.
 */
export function loadConfig(searchDirs: string[], explicitPath?: string): LoadedConfig {
  if (explicitPath) {
    const abs = path.resolve(explicitPath);
    if (!existsSync(abs)) {
      throw new ConfigError(`Config file not found: ${abs}`);
    }
    return { config: readConfigFile(abs), path: abs };
  }

  const seen = new Set<string>();
  for (const dir of searchDirs) {
    const abs = path.resolve(dir, CONFIG_FILE_NAME);
    if (seen.has(abs)) continue;
    seen.add(abs);
    if (existsSync(abs)) {
      return { config: readConfigFile(abs), path: abs };
    }
  }
  return { config: DEFAULT_CONFIG, path: null };
}

function readConfigFile(abs: string): ValtaConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(abs, "utf8"));
  } catch (err) {
    throw new ConfigError(`${abs}: could not parse as JSON (${(err as Error).message}).`);
  }
  return parseConfig(parsed, abs);
}

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
 * Everything is optional. With no file, the scanner behaves exactly as it did
 * before this file existed (retries = 1, no extra per-call costs).
 */
export interface CustomEndpointCost {
  /** Substring matched against the URL passed to a call (e.g. "://proxy-scraping.com"). */
  match_url: string;
  /** Flat USD cost charged every time a matching call runs. */
  cost_per_call: number;
}

export interface ValtaConfig {
  /**
   * How many times an SDK silently re-sends a request on failure. The token
   * ceiling of every LLM call is multiplied by this. Default 1 (no multiplier).
   */
  sdk_default_retries: number;
  custom_endpoint_costs: CustomEndpointCost[];
  /**
   * Average size, in tokens, of one message appended to a conversation history
   * per loop iteration. Only used by the quadratic history-growth estimate.
   * When omitted, the estimate uses the assumed output size of one call.
   */
  average_message_tokens?: number;
}

export const CONFIG_FILE_NAME = "valta.config.json";

export const DEFAULT_CONFIG: ValtaConfig = {
  sdk_default_retries: 1,
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

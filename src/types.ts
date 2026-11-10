export type Severity = "PASS" | "WARN" | "FAIL";

export interface Finding {
  severity: Severity;
  detectorId: "missing-backoff" | "unbounded-loop" | "token-leakage";
  title: string;
  file: string;
  line: number;
  detail: string;
  /**
   * Worst-case dollar-per-hour exposure ceiling, computed from real,
   * dated model pricing plus a labeled latency assumption. Never a
   * historical/claimed loss — only ever a forward-looking bound.
   */
  maxExposurePerHour?: number;
  /** What in this figure is an assumption vs a real, sourced number. */
  assumptionNote?: string;
  /**
   * Deterministic notices about inputs the scanner could not resolve at rest,
   * e.g. a model name read from an environment variable. When present, the
   * exposure figure is a full-context-window worst case.
   */
  warnings?: string[];
}

export interface ScanResult {
  filesScanned: number;
  findings: Finding[];
  /** Path of the valta.config.json that was applied, or null when none was used. */
  configPath?: string | null;
  /** The retry multiplier applied to every dollar figure in this scan. */
  retryMultiplier?: number;
  /** True when the multiplier is the built-in default rather than the user's `sdk_default_retries`. */
  retryMultiplierIsDefault?: boolean;
}

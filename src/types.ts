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
}

export interface ScanResult {
  filesScanned: number;
  findings: Finding[];
}

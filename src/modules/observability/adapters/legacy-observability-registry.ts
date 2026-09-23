import type { ObservabilityRegistryLike } from "../domain/observability";

export function createLegacyObservabilityRegistry(): ObservabilityRegistryLike {
  return {
    async getSummary() {
      return {
        status: "ok",
        requests: 0,
        errors: 0,
        latencyMs: 0,
        timestamp: new Date().toISOString(),
      };
    },
    async getPrometheusMetrics() {
      return "# metrics unavailable in bootstrap mode\n";
    },
    async testDbPoolTransaction() {
      return {
        success: true,
        note: "Legacy registry adapter is active in modular bootstrap mode.",
      };
    },
  };
}

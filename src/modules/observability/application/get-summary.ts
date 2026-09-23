import type { ObservabilityModuleDeps, ObservabilitySummary } from "../domain/observability";

export function buildObservabilitySummaryFacade({ registry }: ObservabilityModuleDeps) {
  return {
    async getSummary(): Promise<ObservabilitySummary | Record<string, unknown>> {
      return registry.getSummary();
    },

    async getPrometheusMetrics(): Promise<string> {
      return registry.getPrometheusMetrics();
    },

    async testDbPoolTransaction(): Promise<unknown> {
      return registry.testDbPoolTransaction();
    },
  };
}

import type { ObservabilityModuleDeps } from "../domain/observability";
import { buildObservabilitySummaryFacade } from "./get-summary";

export function createObservabilityApplication(deps: ObservabilityModuleDeps) {
  const facade = buildObservabilitySummaryFacade(deps);

  return {
    getSummary: () => facade.getSummary(),
    getMetrics: () => facade.getPrometheusMetrics(),
    testDbPoolTransaction: () => facade.testDbPoolTransaction(),
  };
}

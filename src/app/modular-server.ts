import { createApp, startServer } from "./bootstrap";
import { registerAppRoutes } from "./router";
import { registerOpportunityRoutes } from "../modules/opportunities/routes/opportunity-routes";
import { registerSystemRoutes } from "../modules/system/routes/system-routes";
import { registerSecurityRoutes } from "../modules/security/routes/security-routes";
import { registerRadarRoutes } from "../modules/radar/routes/radar-routes";
import { registerObservabilityRoutes } from "../modules/observability/routes/observability-routes";

const legacyObservabilityRegistry = {
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

/**
 * New modular entrypoint.
 *
 * The legacy `server.ts` remains untouched while route groups are migrated
 * incrementally into this composition root.
 */
export function buildModularApp() {
  const app = createApp();
  registerAppRoutes(app);
  registerSystemRoutes(app);
  registerSecurityRoutes(app);
  registerRadarRoutes(app);
  registerObservabilityRoutes(app, legacyObservabilityRegistry);
  registerOpportunityRoutes(app);
  return app;
}

if (process.env.ARKHE_MODULAR_SERVER === "true") {
  startServer(buildModularApp());
}

import { createApp, startServer } from "./bootstrap";
import { registerAppRoutes } from "./router";
import { registerOpportunityRoutes } from "../modules/opportunities/routes/opportunity-routes";
import { registerSystemRoutes } from "../modules/system/routes/system-routes";
import { registerSecurityRoutes } from "../modules/security/routes/security-routes";
import { registerRadarRoutes } from "../modules/radar/routes/radar-routes";
import { registerObservabilityRoutes } from "../modules/observability/routes/observability-routes";
import { createLegacyObservabilityRegistry } from "../modules/observability/adapters/legacy-observability-registry";

/**
 * New modular entrypoint.
 *
 * The legacy `server.ts` remains untouched while route groups are migrated
 * incrementally into this composition root.
 */
export function buildModularApp() {
  const app = createApp();
  const legacyObservabilityRegistry = createLegacyObservabilityRegistry();

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

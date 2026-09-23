import { createApp, startServer } from "./bootstrap";
import { registerAppRoutes } from "./router";
import { registerOpportunityRoutes } from "../modules/opportunities/routes/opportunity-routes";
import { registerSystemRoutes } from "../modules/system/routes/system-routes";

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
  registerOpportunityRoutes(app);
  return app;
}

if (process.env.ARKHE_MODULAR_SERVER === "true") {
  startServer(buildModularApp());
}

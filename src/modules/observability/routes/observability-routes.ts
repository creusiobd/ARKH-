import { Router } from "express";
import { createObservabilityController } from "../controller/observability-controller";
import type { ObservabilityRegistryLike } from "../domain/observability";

export function registerObservabilityRoutes(
  app: { use: (path: string, router: Router) => void },
  registry: ObservabilityRegistryLike,
) {
  const router = Router();
  const controller = createObservabilityController(registry);

  router.get("/summary", controller.getSummary);
  router.get("/metrics", controller.getMetrics);
  router.post("/pgbouncer/test", controller.testDbPoolTransaction);

  app.use("/api/v2/observability", router);
}

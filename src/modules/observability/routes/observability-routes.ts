import { Router } from "express";
import {
  getObservabilitySummaryController,
  getObservabilityMetricsController,
} from "../controller/observability-controller";

export function registerObservabilityRoutes(app: { use: (path: string, router: Router) => void }) {
  const router = Router();

  router.get("/summary", getObservabilitySummaryController);
  router.get("/metrics", getObservabilityMetricsController);

  app.use("/api/v2/observability", router);
}

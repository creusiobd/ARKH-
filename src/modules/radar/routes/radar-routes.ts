import { Router } from "express";
import {
  getRadarHealthController,
  postRadarScanController,
} from "../controller/radar-controller";

export function registerRadarRoutes(app: { use: (path: string, router: Router) => void }) {
  const router = Router();

  router.get("/health", getRadarHealthController);
  router.post("/scan", postRadarScanController);

  app.use("/api/v2/radar", router);
}

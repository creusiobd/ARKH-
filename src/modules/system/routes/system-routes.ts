import { Router } from "express";
import {
  getSystemHealthController,
  getSystemStatusController,
} from "../controller/system-controller";

export function registerSystemRoutes(app: { use: (path: string, router: Router) => void }) {
  const router = Router();

  router.get("/health", getSystemHealthController);
  router.get("/status", getSystemStatusController);

  app.use("/api/v2/system", router);
}

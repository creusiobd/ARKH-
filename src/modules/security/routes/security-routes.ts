import { Router } from "express";
import {
  getSecurityHealthController,
  getSecurityPolicyController,
} from "../controller/security-controller";

export function registerSecurityRoutes(app: { use: (path: string, router: Router) => void }) {
  const router = Router();

  router.get("/health", getSecurityHealthController);
  router.get("/policy", getSecurityPolicyController);

  app.use("/api/v2/security", router);
}

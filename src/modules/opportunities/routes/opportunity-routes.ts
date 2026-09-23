import { Router } from "express";
import { getOpportunityScoreController } from "../controller/opportunity-controller";

export function registerOpportunityRoutes(app: { use: (path: string, router: Router) => void }) {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({
      ok: true,
      module: "opportunities",
      status: "initialized",
    });
  });

  router.get("/score", getOpportunityScoreController);
  router.post("/score", getOpportunityScoreController);

  app.use("/api/v2/opportunities", router);
}

import { Request, Response } from "express";
import { createObservabilityApplication } from "../application/observability-application";
import type { ObservabilityRegistryLike } from "../domain/observability";

export function createObservabilityController(registry: ObservabilityRegistryLike) {
  const app = createObservabilityApplication({ registry });

  return {
    async getSummary(_req: Request, res: Response) {
      try {
        const summary = await app.getSummary();
        res.json({
          ok: true,
          module: "observability",
          architecture: "modular-monolith-bootstrap",
          summary,
        });
      } catch (error) {
        res.status(500).json({
          ok: false,
          module: "observability",
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },

    async getMetrics(_req: Request, res: Response) {
      try {
        const metrics = await app.getMetrics();
        res.setHeader("Content-Type", "text/plain; version=0.0.4");
        res.send(metrics);
      } catch (error) {
        res.status(500).json({
          ok: false,
          module: "observability",
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },

    async testDbPoolTransaction(_req: Request, res: Response) {
      try {
        const result = await app.testDbPoolTransaction();
        res.json({
          ok: true,
          module: "observability",
          result,
        });
      } catch (error) {
        res.status(500).json({
          ok: false,
          module: "observability",
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  };
}

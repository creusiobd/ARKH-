import { Request, Response } from "express";

export function getObservabilitySummaryController(_req: Request, res: Response) {
  res.json({
    ok: true,
    module: "observability",
    architecture: "modular-monolith-bootstrap",
    summary: {
      status: "healthy",
      requests: 0,
      errors: 0,
      latencyMs: 0,
    },
  });
}

export function getObservabilityMetricsController(_req: Request, res: Response) {
  res.json({
    ok: true,
    module: "observability",
    architecture: "modular-monolith-bootstrap",
    metrics: {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      timestamp: new Date().toISOString(),
    },
  });
}

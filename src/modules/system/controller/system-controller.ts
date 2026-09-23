import { Request, Response } from "express";

export function getSystemHealthController(_req: Request, res: Response) {
  res.json({
    status: "ok",
    service: "arkhe-api",
    architecture: "modular-monolith-bootstrap",
    module: "system",
  });
}

export function getSystemStatusController(_req: Request, res: Response) {
  res.json({
    status: "ok",
    service: "arkhe-api",
    architecture: "modular-monolith-bootstrap",
    nodeEnv: process.env.NODE_ENV || "development",
    uptimeSeconds: Number(process.uptime().toFixed(2)),
    timestamp: new Date().toISOString(),
  });
}

import { Request, Response } from "express";
import { runRadarScanUseCase } from "../application/run-radar-scan";

export function getRadarHealthController(_req: Request, res: Response) {
  res.json({
    ok: true,
    module: "radar",
    architecture: "modular-monolith-bootstrap",
    status: "initialized",
  });
}

export function postRadarScanController(req: Request, res: Response) {
  const result = runRadarScanUseCase(req.body ?? {});
  res.json(result);
}

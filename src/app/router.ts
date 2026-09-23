import { Request, Response } from "express";

export function registerAppRoutes(app: {
  get: (path: string, handler: (req: Request, res: Response) => void) => void;
}) {
  app.get("/api/v2/health", (_req, res) => {
    res.json({
      ok: true,
      service: "arkhe-api",
      architecture: "modular-monolith-bootstrap",
    });
  });
}

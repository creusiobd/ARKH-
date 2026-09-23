import { Request, Response } from "express";

export function getSecurityHealthController(_req: Request, res: Response) {
  res.json({
    ok: true,
    module: "security",
    architecture: "modular-monolith-bootstrap",
    checks: {
      shellEscaping: "enabled",
      tenantValidation: "required",
      originControl: "active",
    },
  });
}

export function getSecurityPolicyController(_req: Request, res: Response) {
  res.json({
    ok: true,
    module: "security",
    architecture: "modular-monolith-bootstrap",
    policy: {
      allowlist: ["nmap", "trivy", "git", "nuclei"],
      requireTenantId: true,
      secureCommandExecution: true,
    },
  });
}

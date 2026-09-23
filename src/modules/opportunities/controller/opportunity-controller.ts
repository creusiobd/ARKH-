import { Request, Response } from "express";
import { scoreOpportunityUseCase } from "../application/score-opportunity";

export function getOpportunityScoreController(req: Request, res: Response) {
  const aderencia = Number(req.query.aderencia ?? req.body?.aderencia ?? 0);
  const sinal = Number(req.query.sinal ?? req.body?.sinal ?? 0);
  const fonte = Number(req.query.fonte ?? req.body?.fonte ?? 0);
  const recencia = Number(req.query.recencia ?? req.body?.recencia ?? 0);

  const result = scoreOpportunityUseCase({ aderencia, sinal, fonte, recencia });

  res.json({
    success: true,
    score: result.score,
    qualified: result.qualified,
    inputs: { aderencia, sinal, fonte, recencia },
  });
}

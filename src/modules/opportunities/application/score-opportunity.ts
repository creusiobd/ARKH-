import {
  calculateOpportunityScore,
  isQualifiedForApproach,
  type OpportunityScoreInput,
} from "../domain/opportunity";

export function scoreOpportunityUseCase(input: OpportunityScoreInput): { score: number; qualified: boolean } {
  const score = calculateOpportunityScore(input);

  return {
    score,
    qualified: isQualifiedForApproach(score),
  };
}

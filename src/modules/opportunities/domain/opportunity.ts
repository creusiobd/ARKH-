export type OpportunityStatus =
  | "nova"
  | "verificada"
  | "descartada"
  | "contato preparado"
  | "enviada"
  | "respondeu"
  | "reunião"
  | "proposta"
  | "fechada";

export interface Opportunity {
  id?: string;
  url: string;
  oportunidade: string;
  fonte?: string;
  tipo?: string;
  estado?: OpportunityStatus;
  nota?: number | null;
  data?: string;
  company_size?: string;
  industry_sector?: string;
}

export interface OpportunityScoreInput {
  aderencia: number;
  sinal: number;
  fonte: number;
  recencia: number;
}

export function calculateOpportunityScore({ aderencia, sinal, fonte, recencia }: OpportunityScoreInput): number {
  return 7 * aderencia + 6 * sinal + 4 * fonte + 3 * recencia;
}

export function isQualifiedForApproach(score: number): boolean {
  return score >= 70;
}

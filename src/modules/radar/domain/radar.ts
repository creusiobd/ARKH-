export interface RadarSignal {
  company: string;
  source: string;
  sourceUrl: string;
  signal: string;
  hypothesis: string;
  urgency: "Alta" | "Média" | "Baixa";
  targetRole: string;
  approachHook: string;
  estimatedContractBrl: number;
  costOfInactionHourlyBrl: number;
}

export interface RadarScanRequest {
  tema?: string;
  scenario?: "live" | "standard" | "excess" | "mixed";
  segmento?: "geral" | "fintech" | "ecommerce" | "logistica" | "saas";
  foco?: "todos" | "diagnostico" | "vagas";
}

export function normalizeRadarScanRequest(request: RadarScanRequest = {}): Required<RadarScanRequest> {
  return {
    tema: request.tema || "SRE e observabilidade no Brasil",
    scenario: request.scenario || "live",
    segmento: request.segmento || "geral",
    foco: request.foco || "todos",
  };
}

export function createMockRadarSignals(tema: string): RadarSignal[] {
  return [
    {
      company: "Nubank",
      source: "Carreira SRE / Blog Técnico",
      sourceUrl: "https://nubank.com.br/carreiras/eng/observability-staff",
      signal: `Sinal de mercado relevante para ${tema} com foco em confiabilidade e SLOs de alta criticidade.`,
      hypothesis: "Necessidade de governança de SLIs e contenção de falhas em cascata em serviços de pagamentos críticos.",
      urgency: "Alta",
      targetRole: "Head de SRE e Observabilidade",
      approachHook: "Diagnóstico de 5 dias para mapear pontos cegos de observabilidade e reduzir MTTR em transações críticas.",
      estimatedContractBrl: 85000,
      costOfInactionHourlyBrl: 240000,
    },
    {
      company: "Mercado Livre",
      source: "Engineering Blog / Vagas",
      sourceUrl: "https://mercadolivre.com.br/tech/open-telemetry-kubernetes-scale",
      signal: `Escala e latência em ambientes de alto volume para ${tema}.`,
      hypothesis: "Saturação de pipelines de telemetria e contenção de recursos em microsserviços sob carga extrema.",
      urgency: "Alta",
      targetRole: "Staff Platform Engineer",
      approachHook: "Ajustar arquitetura de métricas, tracing e alertas para reduzir blast radius e acelerar resposta a incidentes.",
      estimatedContractBrl: 90000,
      costOfInactionHourlyBrl: 350000,
    },
  ];
}

import {
  createMockRadarSignals,
  normalizeRadarScanRequest,
  type RadarScanRequest,
} from "../domain/radar";

export function runRadarScanUseCase(request: RadarScanRequest = {}) {
  const normalized = normalizeRadarScanRequest(request);
  const signals = createMockRadarSignals(normalized.tema);

  return {
    success: true,
    mode: normalized.scenario,
    segmento: normalized.segmento,
    foco: normalized.foco,
    tema: normalized.tema,
    signals,
    totalSignals: signals.length,
    summary: {
      qualified: signals.length,
      riskLevel: signals.some((s) => s.urgency === "Alta") ? "Alta" : "Média",
    },
  };
}

export interface ObservabilitySummary {
  status: string;
  requests: number;
  errors: number;
  latencyMs: number;
  timestamp?: string;
}

export interface ObservabilityMetrics {
  uptime: number;
  memory: NodeJS.MemoryUsage;
  timestamp: string;
}

export interface ObservabilityRegistryLike {
  getSummary(): Promise<ObservabilitySummary | Record<string, unknown>>;
  getPrometheusMetrics(): Promise<string>;
  testDbPoolTransaction(): Promise<unknown>;
}

export interface ObservabilityModuleDeps {
  registry: ObservabilityRegistryLike;
}

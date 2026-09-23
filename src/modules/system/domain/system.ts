export interface SystemHealth {
  status: string;
  service: string;
  architecture: string;
  module: string;
  timestamp?: string;
}

export interface SystemStatus {
  status: string;
  service: string;
  architecture: string;
  nodeEnv: string;
  uptimeSeconds: number;
  timestamp: string;
}

export interface SystemGateway {
  getHealth(): Promise<SystemHealth>;
  getStatus(): Promise<SystemStatus>;
}

export interface SystemModuleDeps {
  gateway: SystemGateway;
}

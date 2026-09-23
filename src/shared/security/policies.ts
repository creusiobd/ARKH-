export interface SharedSecurityPolicies {
  allowlist: string[];
  requireTenantId: boolean;
}

export const sharedSecurityPolicies: SharedSecurityPolicies = {
  allowlist: ["nmap", "trivy", "git", "nuclei"],
  requireTenantId: true,
};

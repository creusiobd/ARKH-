export const env = {
  isProduction: process.env.NODE_ENV === "production",
  getString(name: string, fallback = ""): string {
    return process.env[name] ?? fallback;
  },
  getNumber(name: string, fallback: number): number {
    const value = Number(process.env[name]);
    return Number.isFinite(value) ? value : fallback;
  },
};

import type { HealthAdapter } from "./health-types";
export async function getHealthAdapter(): Promise<HealthAdapter> {
  throw new Error("healthUnavailable");
}

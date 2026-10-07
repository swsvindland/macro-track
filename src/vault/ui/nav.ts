// Navigation to the vault's routes (docs/vault.md, "Wiring a repo"; spec §1.6, §11.1). The only place that casts a
// vault route to Href: all four apps use typed routes, and the generated route list (.expo/types/router.d.ts) names
// the vault routes only after a dev server regenerated it, so tsc must never depend on it. The route files are
// `src/app/vault/*` (synced); M1 ships only `import`, and M1 code never navigates to `backup` or `cloud`.
import { router, type Href } from "expo-router";

export const vaultRoutes = {
  backup: "/vault",
  import: "/vault/import",
  cloud: "/vault/cloud",
} as const;

export type VaultRoute = keyof typeof vaultRoutes;

/** Opens a vault screen (push by default; replace where the current screen must not stay behind it). */
export function goVault(route: VaultRoute, mode: "push" | "replace" = "push"): void {
  router[mode](vaultRoutes[route] as Href);
}

/** Leaves a vault screen: back where there is history, else the app's home (a cold start from a file has none). */
export function leaveVault(): void {
  if (router.canGoBack()) router.back();
  else router.replace("/" as Href);
}

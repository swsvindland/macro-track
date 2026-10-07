// The only UI-side import of app code (docs/vault.md, "How an app plugs in"): the app's React hook that re-reads its
// stores after a restore. Vault screens import it from here; engine and headless code never do.
export { useVaultRefresh } from "@/vault-app-ui";

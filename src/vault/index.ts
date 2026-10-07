// Vault UI barrel: what an app's settings screen (<VaultSection />) and root layout (<VaultRoot />) import, plus the
// contract types. App lib code never imports it; it reaches the vault through leaf modules (docs/vault.md).
export { VaultRoot } from "./ui/root";
export { VaultSection } from "./ui/section";
export type * from "./types";

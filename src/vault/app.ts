// The only engine-side import of app code (docs/vault.md, "How an app plugs in"): engine, cloud, the background task
// and the tests read the app's descriptor and identity from here. Static, so the descriptor exists in headless runs.
// Leaf modules (errors, engine/db, csv, provenance, source, incoming) must never reach this file (vault-kit check).
import { vaultApp as descriptor } from "@/vault-app";

import apps from "./apps.json";
import type { AppIdentity, VaultApp } from "./types";

/** The app's descriptor (src/vault-app.ts), checked against the contract here. */
export const vaultApp: VaultApp = descriptor;

/** This app's row of src/vault/apps.json: brand name, bundle id, extension, UTI, MIME, database, media folders. */
export const vaultIdentity: AppIdentity = apps[vaultApp.id];

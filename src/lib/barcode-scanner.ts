import { Camera, CameraView, type BarcodeType } from "expo-camera";
import { Platform } from "react-native";
// The system scanner is a modal of its own, so like an Editor it waits for sheets still sliding
// away: UIKit ignores a present meanwhile and the scanner would never appear.
import { afterLeaving } from "@/vector/sheets";

/** Food barcodes: EAN-13, EAN-8, UPC-A, UPC-E and ITF-14 (case codes). */
export const foodBarcodeTypes: BarcodeType[] = ["ean13", "ean8", "upc_a", "upc_e", "itf14"];

export type ScannedCode = { data: string; type: string };

// Google's code scanner reports ML Kit's format numbers.
const mlKitFormats: Record<number, string> = {
  32: "ean13",
  64: "ean8",
  128: "itf14",
  512: "upc_a",
  1024: "upc_e",
};
const visionNames: Record<string, string> = {
  ean13: "ean13",
  ean8: "ean8",
  upca: "upc_a",
  upce: "upc_e",
  itf14: "itf14",
};

/**
 * A scanner's name for a symbology as the in-app camera names it, which barcodeCandidates reads to
 * tell UPC-E from EAN-8: VisionKit's "VNBarcodeSymbologyUPCE" and ML Kit's 1024 are both upc_e.
 */
export function symbologyName(type: unknown): string {
  if (typeof type === "number") return mlKitFormats[type] ?? String(type);
  const text = String(type ?? "");
  const key = text
    .toLowerCase()
    .replace(/^vnbarcodesymbology/, "")
    .replace(/[^a-z0-9]/g, "");
  return visionNames[key] ?? text;
}

// Set once the system scanner fails to open here (an iPhone older than the XS, a simulator, an
// Android phone without Play services), so later scans use the in-app camera straight away.
let missing = false;
let listening: { remove(): void } | null = null;
// A second tap while the scanner slides up would stack another scanner on it.
let openedAt = -Infinity;

/** Whether to offer the phone's own scanner; the in-app camera stands in where it can't open. */
export function systemScannerOffered() {
  return !missing && Platform.OS !== "web" && CameraView.isModernBarcodeScannerAvailable === true;
}

/**
 * Opens the phone's own barcode scanner over the app: VisionKit on iPhone, Google's code scanner on
 * Android. They pick the lens that focuses up close and read a code in a frame or two, where the
 * in-app camera's fixed wide lens can't focus on a label held near it.
 *
 * Resolves with the first code once the scanner has left the screen, so the next sheet can present;
 * with null when it was closed without one on Android; and with "unavailable" when it can't open
 * here. A swipe down on iPhone reports nothing, so that call never resolves, and the next one
 * replaces it. A code in `skip` (one just added, still in view) is passed over.
 */
export async function scanWithSystemScanner(
  skip = ""
): Promise<ScannedCode | null | "unavailable"> {
  if (!systemScannerOffered()) return "unavailable";
  if (Date.now() - openedAt < 1000) return null;
  openedAt = Date.now();
  // VisionKit opens only with camera access; Google's scanner needs none.
  if (Platform.OS === "ios") {
    const permission = await Camera.requestCameraPermissionsAsync().catch(() => null);
    if (!permission?.granted) return "unavailable";
  }
  await new Promise<void>((resolve) => afterLeaving(resolve));
  listening?.remove();
  return new Promise((resolve) => {
    let taken = false;
    const subscription = CameraView.onModernBarcodeScanned(({ data, type }) => {
      // VisionKit reports the code again on every frame until it has closed.
      if (taken || !data || data === skip) return;
      taken = true;
      subscription.remove();
      if (listening === subscription) listening = null;
      const code = { data, type: symbologyName(type) };
      // Android's scanner has already closed; the iPhone's resolves this once it has slid away.
      void CameraView.dismissScanner()
        .catch(() => {})
        .then(() => resolve(code));
    });
    listening = subscription;
    CameraView.launchScanner({ barcodeTypes: foodBarcodeTypes, isHighlightingEnabled: true }).catch(
      (error: unknown) => {
        if (taken) return;
        subscription.remove();
        if (listening === subscription) listening = null;
        // Android rejects a cancel; anything else means the scanner can't run on this phone.
        const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
        if (/cancel/i.test(`${code} ${message}`)) resolve(null);
        else {
          missing = true;
          resolve("unavailable");
        }
      }
    );
  });
}

import type { ReactNode } from "react";
import { EditorPresenceProvider, VectorProvider } from "@/vector";
import { closeOnAppAction } from "@/lib/app-actions";
import { useStore } from "@/lib/store";

/**
 * The kit's view of the app: the chosen language, and the deep-link closer for open Editors.
 * expo-haptics is not installed here, so haptics stay the kit's no-op; the SF Symbols renderer
 * waits for its device check.
 */
export function VectorAdapter({ children }: { children: ReactNode }) {
  const { language } = useStore();
  return (
    <VectorProvider language={language}>
      {/* iOS shows one sheet at a time: a macrotrack:// link closes Editors outside Home. */}
      <EditorPresenceProvider value={closeOnAppAction}>{children}</EditorPresenceProvider>
    </VectorProvider>
  );
}

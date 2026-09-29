import { createContext, useContext, type ReactNode } from "react";
import { View } from "react-native";
import {
  Choices as KitChoices,
  Editor as KitEditor,
  EditorPresenceProvider,
  Screen as KitScreen,
  type EditorProps,
  type ScreenProps,
} from "@/vector";
import { HomeSheets } from "@/lib/app-actions";
import { useStore } from "@/lib/store";
import { isMessage } from "@/lib/translations";

/**
 * Migration shim (KIT §7): the old ui.tsx names over the Vector kit, so every call site keeps
 * compiling while it moves to "@/vector".
 */

export { DateInput, ErrorText, Field, useEditorPortalHost } from "@/vector";

/** The footer for Screens inside that pass none, e.g. a tab's quick-log bar. */
export const ScreenFooter = createContext<ReactNode>(null);

/** Kit Screen; the tab's shared footer docks when the screen brings none of its own. */
export function Screen({ footer, ...props }: ScreenProps) {
  const shared = useContext(ScreenFooter);
  return <KitScreen {...props} footer={footer ?? shared} />;
}

/**
 * Kit Choices; options that are translation keys label themselves until each call site passes
 * `label`.
 */
export function Choices<T extends string>({
  values,
  value,
  onChange,
  label,
  accessibilityLabel,
  size,
  mono,
}: {
  values: readonly T[];
  value: T;
  onChange: (value: T) => void;
  label?: (value: T) => string;
  accessibilityLabel?: string;
  size?: "md" | "sm";
  mono?: boolean;
}) {
  const { t } = useStore();
  return (
    <KitChoices
      values={values}
      value={value}
      onChange={onChange}
      label={label ?? ((option) => (isMessage(option) ? t(option) : option))}
      accessibilityLabel={accessibilityLabel ?? ""}
      size={size}
      mono={mono}
    />
  );
}

/**
 * Kit Editor. Footer content written for the old full-width bar keeps its width in the kit's footer
 * row, and sheets on Home stay open for a link (Home closes its own), so they opt out of the
 * adapter's link closer.
 */
export function Editor({ footer, ...props }: EditorProps) {
  const home = useContext(HomeSheets);
  const editor = (
    <KitEditor {...props} footer={footer ? <View className="flex-1">{footer}</View> : undefined} />
  );
  return home ? <EditorPresenceProvider value={null}>{editor}</EditorPresenceProvider> : editor;
}

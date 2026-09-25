import { DeferredTab } from "@/components/deferred-tab";
import { SettingsScreen } from "@/components/screens/settings-screen";

export default function SettingsTab() {
  return (
    <DeferredTab>
      <SettingsScreen />
    </DeferredTab>
  );
}

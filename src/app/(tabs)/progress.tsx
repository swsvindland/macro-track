import { DeferredTab } from "@/components/deferred-tab";
import { TabQuickLogBar } from "@/components/nutrition/quick-log-bar";
import { ProgressScreen } from "@/components/progress/progress-screen";
import { ScreenFooter } from "@/components/ui";

export default function ProgressTab() {
  return (
    <DeferredTab>
      <ScreenFooter value={<TabQuickLogBar />}>
        <ProgressScreen />
      </ScreenFooter>
    </DeferredTab>
  );
}

import { DeferredTab } from "@/components/deferred-tab";
import { PlanScreen } from "@/components/nutrition/plan-screen";
import { TabQuickLogBar } from "@/components/nutrition/quick-log-bar";
import { ScreenFooter } from "@/components/ui";

export default function PlanTab() {
  return (
    <DeferredTab>
      <ScreenFooter value={<TabQuickLogBar />}>
        <PlanScreen />
      </ScreenFooter>
    </DeferredTab>
  );
}

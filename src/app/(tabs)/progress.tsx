import { DeferredTab } from "@/components/deferred-tab";
import { ProgressScreen } from "@/components/progress/progress-screen";

export default function ProgressTab() {
  return (
    <DeferredTab>
      <ProgressScreen />
    </DeferredTab>
  );
}

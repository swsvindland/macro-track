import { DeferredTab } from "@/components/deferred-tab";
import { WeightLog } from "@/components/measurements/weight-log";

export default function ProgressTab() {
  return (
    <DeferredTab>
      <WeightLog />
    </DeferredTab>
  );
}

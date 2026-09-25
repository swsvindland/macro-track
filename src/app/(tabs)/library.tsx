import { DeferredTab } from "@/components/deferred-tab";
import { LibraryScreen } from "@/components/nutrition/library-screen";

export default function LibraryTab() {
  return (
    <DeferredTab>
      <LibraryScreen />
    </DeferredTab>
  );
}

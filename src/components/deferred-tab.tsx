import { useCallback, useState, type ReactNode } from "react";
import { useFocusEffect, useIsFocused } from "expo-router";

/** Keep charts and library reads off the first Home render, then retain drafts. */
export function DeferredTab({ children }: { children: ReactNode }) {
  const focused = useIsFocused();
  const [visited, setVisited] = useState(false);
  useFocusEffect(
    useCallback(() => {
      setVisited(true);
    }, [])
  );
  return focused || visited ? children : null;
}

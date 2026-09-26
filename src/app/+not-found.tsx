import { router, useFocusEffect } from "expo-router";

/** Unknown routes open Today, going back to the Home already open rather than adding a second. */
export default function NotFound() {
  useFocusEffect(() => {
    router.dismissTo("/");
  });
  return null;
}

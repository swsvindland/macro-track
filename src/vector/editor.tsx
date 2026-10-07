import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import {
  BackHandler,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  View,
  useWindowDimensions,
} from "react-native";
import {
  SafeAreaView as NativeSafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { Stack, useFocusEffect } from "expo-router";
import { PortalHost } from "heroui-native";
import { withUniwind } from "uniwind";
import { Button, LinkButton } from "./button";
import { EditorPortalContext, SignalBudget, useEditorPortalHost, useKitStrings } from "./provider";
import { ScreenFooter } from "./screen";
import { afterLeaving, leave, settle } from "./sheets";
import { Heading, Label } from "./text";

// Third-party native views need a Uniwind adapter for className styles.
// Without flex-1, the modal's safe-area container collapses and hides the form.
const SafeAreaView = withUniwind(NativeSafeAreaView);

/** Where a field's picker portals to, so DateInput, TimeInput, Select and menus open above the sheet they sit in. */
export { useEditorPortalHost };

/**
 * App hook point for open Editors: called with the sheet's `close` while it is open; return the unregister.
 * macro wires its deep-link closer here (useCloseForAppAction: iOS shows one sheet at a time, so a
 * macrotrack:// link closes sheets outside Home). Pass `null` in a subtree whose sheets must stay open (Home).
 */
export type EditorPresence = ((close: () => void) => () => void) | null;
const PresenceContext = createContext<EditorPresence>(null);
export const EditorPresenceProvider = ({
  value,
  children,
}: {
  value: EditorPresence;
  children: ReactNode;
}) => <PresenceContext.Provider value={value}>{children}</PresenceContext.Provider>;

export type EditorProps = {
  title: string;
  /** Mono context above the title, e.g. "Record / Weight". */
  eyebrow?: string;
  open: boolean;
  close: () => void;
  /** A save is running: Cancel, swipe and Android back are held. */
  busy?: boolean;
  /** Unsaved edits: the sheet resists the swipe and ignores Android back; Cancel or the primary are the exits. */
  dirty?: boolean;
  /**
   * `close` may keep the sheet open: it steps back inside it (a portion view back to the list) or asks first.
   * The sheet then never leaves on its own: iOS holds the swipe and turns the attempt into `close`, and Android
   * back calls `close`, so the app decides. (`busy` still holds everything.)
   */
  guarded?: boolean;
  /**
   * The sheet has left the screen (after the slide, or at once after a swipe). Open the next sheet, an alert or a
   * route from here; another Editor needs no wait, it queues itself behind a sheet that is still leaving. A swiped
   * sheet that `close` keeps open is presented again, and this does not fire for it.
   */
  onDismissed?: () => void;
  /** Extra docked content (existing call sites); rendered in the footer bar before `primary`. */
  footer?: ReactNode;
  /** The one primary action: full width, lg, pinned in the footer, riding the keyboard. */
  primary?: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
    loading?: boolean;
    /** Shown while loading (default: kit "Saving…"), e.g. "Reading…" for an import. */
    loadingLabel?: string;
  };
  /** Delete and the like: a destructive Button at the end of the scroll, never next to the primary. */
  destructive?: { label: string; onPress: () => void };
  /** Tighter body rhythm (12 gap) for short forms. */
  compact?: boolean;
  scrollRef?: Ref<ScrollView>;
  children: ReactNode;
};

type SheetProps = Omit<EditorProps, "open" | "close" | "guarded" | "onDismissed"> & {
  onCancel: () => void;
};

/**
 * Header (56: title at start, Cancel at end; text only, so nothing touches the sheet corner), a form-width
 * scroll body, and the footer bar. Owns the per-sheet PortalHost and the signal budget.
 */
function Sheet({
  title,
  eyebrow,
  busy = false,
  footer,
  primary,
  destructive,
  compact = false,
  scrollRef,
  onCancel,
  children,
}: SheetProps) {
  const strings = useKitStrings();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const portalHost = useId();
  const gutter = width < 600 ? 16 : 24;
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <EditorPortalContext.Provider value={portalHost}>
        <SignalBudget name="editor">
          <SafeAreaView className="flex-1 bg-background">
            {/* A page sheet starts below the status bar; without this offset the footer sits under the keyboard. */}
            <KeyboardAvoidingView
              style={{ flex: 1 }}
              behavior={Platform.OS === "ios" ? "padding" : undefined}
              keyboardVerticalOffset={Platform.OS === "ios" ? insets.top : 0}
            >
              <View
                className="min-h-14 flex-row items-center gap-3 pt-2"
                style={{ paddingHorizontal: gutter }}
              >
                <View className="flex-1 gap-1">
                  {eyebrow ? <Label>{eyebrow}</Label> : null}
                  <Heading level={2}>{title}</Heading>
                </View>
                <LinkButton onPress={onCancel} disabled={busy}>
                  {strings.cancel}
                </LinkButton>
              </View>
              {/* No automaticallyAdjustKeyboardInsets: the KeyboardAvoidingView already shrinks this ScrollView, and a
                  native keyboard inset on top of that leaves a keyboard-high blank overscroll under every form. */}
              <ScrollView
                ref={scrollRef}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="on-drag"
                contentContainerStyle={{
                  padding: gutter,
                  gap: compact ? 12 : 16,
                  paddingBottom: 40,
                  maxWidth: 640 + gutter * 2,
                  width: "100%",
                  alignSelf: "center",
                }}
              >
                {children}
                {destructive ? (
                  <Button
                    variant="destructive"
                    disabled={busy}
                    onPress={destructive.onPress}
                    className="mt-4 self-start"
                  >
                    {destructive.label}
                  </Button>
                ) : null}
              </ScrollView>
              {footer || primary ? (
                <ScreenFooter>
                  {footer}
                  {primary ? (
                    <Button
                      variant="primary"
                      size="lg"
                      className="flex-1"
                      disabled={primary.disabled || busy}
                      loading={primary.loading}
                      loadingLabel={primary.loadingLabel}
                      onPress={primary.onPress}
                    >
                      {primary.label}
                    </Button>
                  ) : null}
                </ScreenFooter>
              ) : null}
            </KeyboardAvoidingView>
          </SafeAreaView>
          {/* Keeps calendar, select and menu overlays above the native sheet on both platforms. */}
          <PortalHost name={portalHost} />
        </SignalBudget>
      </EditorPortalContext.Provider>
    </GestureHandlerRootView>
  );
}

const ios = Platform.OS === "ios";
const web = Platform.OS === "web";

/**
 * Web: react-native-web's Modal ignores presentationStyle and swipe dismissal, so the sheet is a centred dialog
 * at most 640 wide (the `form` width) over the backdrop, 1pt border, overlay shadow, radius 4. The backdrop and
 * Escape (onRequestClose) are the swipe and Android back: `request` applies the same holds. The Modal's own
 * container is the dialog element (role="dialog", aria-modal), named by the Editor.
 */
function WebDialog({ request, children }: { request: () => void; children: ReactNode }) {
  return (
    <View className="flex-1 items-center justify-center p-6">
      {/* Not a tab stop: Escape and Cancel are the keyboard's ways out. */}
      <Pressable
        accessibilityRole="none"
        tabIndex={-1}
        onPress={request}
        className="absolute inset-0 bg-backdrop"
      />
      <View
        className="w-full overflow-hidden rounded-panel border border-border bg-background shadow-overlay"
        style={{ maxWidth: 640, maxHeight: "100%" }}
      >
        {children}
      </View>
    </View>
  );
}

/**
 * Data entry sheet: RN Modal pageSheet with the default slide. A clean sheet swipes away; a dirty or busy one
 * resists (iOS isModalInPresentation) and ignores Android back; a `guarded` one resists and hands the attempt to
 * `close`. There is no "Discard changes?" confirm. Opening waits for a sheet that is still sliding away (iOS), so
 * one Editor can close and the next open in the same commit. On web it is a centred dialog (WebDialog) with the
 * same header, body, footer and holds.
 */
export function Editor({
  open,
  close,
  busy = false,
  dirty = false,
  guarded = false,
  onDismissed,
  ...sheet
}: EditorProps) {
  const presence = useContext(PresenceContext);
  const id = useId();
  const held = busy || dirty || guarded;
  useEffect(() => (open && presence ? presence(close) : undefined), [open, presence, close]);
  // Android presents at once; iOS shows the sheet only after any other sheet has finished leaving.
  const [ready, setReady] = useState(!ios);
  if (ios && !open && ready) setReady(false);
  // A layout effect runs after the commit's cleanups, so a sheet closing in the same commit is already leaving.
  useLayoutEffect(() => (ios && open ? afterLeaving(() => setReady(true)) : undefined), [open]);
  const visible = open && ready;
  // A `close` that kept a swiped-away sheet open would leave RN's modal mounted and invisible: present it again.
  const [epoch, setEpoch] = useState(0);
  const [gone, setGone] = useState(false);
  if (gone && !open) setGone(false);
  if (gone && open) {
    setGone(false);
    setEpoch(epoch + 1);
  }
  // Set when a swipe took the sheet away: nothing is left to slide.
  const swiped = useRef(false);
  const dismissed = useRef(onDismissed);
  useLayoutEffect(() => {
    dismissed.current = onDismissed;
  });
  // One run per stay on screen; the cleanup is its departure. A re-presented sheet (new epoch) is the same stay,
  // so onDismissed never fires for a sheet that is sliding straight back up.
  useLayoutEffect(() => {
    if (!visible) return;
    return () => {
      const done = () => dismissed.current?.();
      if (!ios || swiped.current) done();
      else leave(id, done);
    };
  }, [visible, id]);
  // Every presentation, a re-presented one too, slides away again unless a swipe takes it.
  useLayoutEffect(() => {
    if (visible) swiped.current = false;
  }, [visible, epoch]);
  if (web) {
    // The backdrop and Escape stand in for the swipe: a clean sheet closes, a dirty or busy one holds, and a
    // guarded one hands the attempt to `close`.
    const request = () => {
      if (busy || (dirty && !guarded)) return;
      close();
    };
    return (
      <Modal
        visible={visible}
        transparent
        animationType="fade"
        onRequestClose={request}
        onDismiss={() => settle(id)}
        // react-native-web passes it to the role="dialog" element: the dialog's accessible name.
        aria-label={sheet.title}
      >
        <WebDialog request={request}>
          <Sheet {...sheet} busy={busy} onCancel={close} />
        </WebDialog>
      </Modal>
    );
  }
  return (
    <Modal
      key={epoch}
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      allowSwipeDismissal={!held}
      // iOS: a swipe on a free sheet has already dismissed it; on a held one it is only an attempt.
      // Android: the back button.
      onRequestClose={() => {
        if (busy || (dirty && !guarded)) return;
        if (ios && !guarded) {
          swiped.current = true;
          setGone(true);
        }
        close();
      }}
      onDismiss={() => settle(id)}
    >
      <Sheet {...sheet} busy={busy} onCancel={close} />
    </Modal>
  );
}

export type EditorScreenProps = Omit<EditorProps, "open" | "close" | "guarded" | "onDismissed"> & {
  onClose: () => void;
  /**
   * `onClose` may keep the route open (it steps back inside it or asks first). The route's iOS swipe is held and
   * does nothing (unlike Editor, the attempt is not turned into `onClose`); Android back calls `onClose`. Cancel
   * and the primary call `onClose` themselves. (`busy` still holds everything.)
   */
  guarded?: boolean;
};

/**
 * The Editor for existing `presentation: "modal"` routes (water drink, favorites): the route is the sheet, so
 * this renders the same header, body and footer. While dirty, guarded or busy it holds the iOS swipe (route
 * options) and holds Android back (guarded: back calls `onClose`, which may step back or ask); Cancel and the
 * primary still close it, because they call `onClose` themselves.
 */
export function EditorScreen({
  onClose,
  busy = false,
  dirty = false,
  guarded = false,
  ...sheet
}: EditorScreenProps) {
  const held = busy || dirty || guarded;
  const stepBack = guarded && !busy;
  // Only hardware / gesture back is held (not usePreventRemove, which would also block Cancel's router.back()),
  // and only while this route is focused, so a picker route pushed on top keeps its own back.
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== "android" || !held) return;
      const sub = BackHandler.addEventListener("hardwareBackPress", () => {
        if (stepBack) onClose();
        return true;
      });
      return () => sub.remove();
    }, [held, stepBack, onClose])
  );
  return (
    <>
      <Stack.Screen options={{ gestureEnabled: !held }} />
      <Sheet {...sheet} busy={busy} onCancel={onClose} />
    </>
  );
}

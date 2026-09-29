import {
  Easing,
  FadeIn,
  FadeOut,
  LinearTransition,
  useReducedMotion,
  type EasingFunction,
  type EasingFunctionFactory,
} from "react-native-reanimated";
import { useOptionalKit } from "./provider";

/** One duration scale (design-system §7). No springs, no bounce, no scale-on-press anywhere in the kit. */
export const duration = {
  /** press colour */
  instant: 100,
  /** selection, toggle, dock content swap, exit fades */
  fast: 150,
  /** enter fades, splash hide, list insert */
  normal: 200,
  /** meter change, layout reflow */
  slow: 300,
  /** signal pulse: hold 300 + fade 300 */
  pulse: 600,
  /** one ProcessLine sweep (stops after 5s) */
  scan: 900,
} as const;

/**
 * One curve. The beziers are Reanimated factories, not plain functions: a bezier closure built on the JS thread
 * is not a worklet, so withTiming and layout builders must receive the factory and build it on the UI thread.
 */
export const easing: {
  standard: EasingFunctionFactory;
  exit: EasingFunctionFactory;
  linear: EasingFunction;
} = {
  standard: Easing.bezier(0.2, 0.8, 0.2, 1),
  exit: Easing.bezier(0.4, 0, 1, 1),
  /** timers and the scan sweep */
  linear: Easing.linear,
};

/**
 * Reduce Motion from the VectorProvider (live: it listens for changes); outside a provider, Reanimated's value
 * read at startup. Under Reduce Motion there is no pulse, no scan, no layout transition, and meters jump.
 */
export function useReducedMotionSafe(): boolean {
  const system = useReducedMotion();
  const kit = useOptionalKit();
  return kit ? kit.reduceMotion : system;
}

const listMotion = {
  layout: LinearTransition.duration(duration.normal).easing(easing.standard),
  entering: FadeIn.duration(duration.fast),
  exiting: FadeOut.duration(duration.instant),
};

/** List insert and remove: spread onto an Animated.View row. Empty under Reduce Motion. No slides. */
export function useListMotion(): Partial<typeof listMotion> {
  return useReducedMotionSafe() ? {} : listMotion;
}

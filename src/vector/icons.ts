import type { ComponentProps } from "react";
import type { Ionicons } from "@expo/vector-icons";

/** Every Ionicons glyph name (the default renderer; the migration shims still accept these). */
export type IoniconsName = ComponentProps<typeof Ionicons>["name"];
export type IconSpec = {
  /** SF Symbol (iOS; used by the optional SymbolView adapter and the Swift targets). */
  sf: string;
  /** Material Symbol (Android; optional adapter). */
  md: string;
  /** Default renderer in every repo: @expo/vector-icons Ionicons (installed in all four). */
  ion: IoniconsName;
  /** Directional: flipped with scaleX(-1) when I18nManager.isRTL. */
  mirrors?: boolean;
};

/** The only place glyph names exist. Semantic keys; app-specific glyphs are added here (kit bump). */
export const icons = {
  add: { sf: "plus", md: "add", ion: "add" },
  /** Stepper minus (lift program-editor and travel steppers). */
  remove: { sf: "minus", md: "remove", ion: "remove" },
  close: { sf: "xmark", md: "close", ion: "close" },
  back: { sf: "chevron.backward", md: "arrow_back", ion: "chevron-back", mirrors: true },
  forward: { sf: "chevron.forward", md: "chevron_right", ion: "chevron-forward", mirrors: true },
  down: { sf: "chevron.down", md: "expand_more", ion: "chevron-down" },
  more: { sf: "ellipsis", md: "more_horiz", ion: "ellipsis-horizontal" },
  search: { sf: "magnifyingglass", md: "search", ion: "search" },
  clear: { sf: "xmark.circle.fill", md: "cancel", ion: "close-circle" },
  edit: { sf: "pencil", md: "edit", ion: "pencil" },
  delete: { sf: "trash", md: "delete", ion: "trash-outline" },
  undo: { sf: "arrow.uturn.backward", md: "undo", ion: "arrow-undo", mirrors: true },
  move: { sf: "arrow.turn.up.right", md: "redo", ion: "arrow-redo-outline", mirrors: true },
  check: { sf: "checkmark", md: "check", ion: "checkmark" },
  done: { sf: "checkmark.circle.fill", md: "check_circle", ion: "checkmark-circle" },
  over: { sf: "exclamationmark.circle.fill", md: "error", ion: "alert-circle" },
  info: { sf: "info.circle", md: "info", ion: "information-circle-outline" },
  warning: { sf: "exclamationmark.triangle", md: "warning", ion: "warning-outline" },
  date: { sf: "calendar", md: "calendar_today", ion: "calendar-outline" },
  time: { sf: "clock", md: "schedule", ion: "time-outline" },
  timer: { sf: "timer", md: "timer", ion: "timer-outline" },
  sync: { sf: "arrow.triangle.2.circlepath", md: "sync", ion: "sync" },
  camera: { sf: "camera", md: "photo_camera", ion: "camera-outline" },
  scan: { sf: "barcode.viewfinder", md: "barcode_scanner", ion: "barcode-outline" },
  analysis: { sf: "sparkles", md: "auto_awesome", ion: "sparkles-outline" },
  settings: { sf: "gearshape", md: "settings", ion: "settings-outline" },
  filter: { sf: "line.3.horizontal.decrease", md: "filter_list", ion: "filter" },
  share: { sf: "square.and.arrow.up", md: "share", ion: "share-outline" },
  external: { sf: "arrow.up.right", md: "open_in_new", ion: "open-outline", mirrors: true },
  play: { sf: "play.fill", md: "play_arrow", ion: "play" },
  favorite: { sf: "star", md: "star", ion: "star-outline" },
  record: { sf: "trophy", md: "trophy", ion: "trophy-outline" },
  chart: { sf: "chart.xyaxis.line", md: "monitoring", ion: "analytics-outline" },
  history: { sf: "clock.arrow.circlepath", md: "history", ion: "time-outline" },
  weight: { sf: "scalemass", md: "monitor_weight", ion: "barbell-outline" },
  lift: { sf: "dumbbell", md: "fitness_center", ion: "barbell-outline" },
  food: { sf: "fork.knife", md: "restaurant", ion: "restaurant-outline" },
  water: { sf: "drop", md: "water_drop", ion: "water-outline" },
  coffee: { sf: "cup.and.saucer", md: "coffee", ion: "cafe-outline" },
  tea: { sf: "leaf", md: "eco", ion: "leaf-outline" },
  // A glass, not a second cup: with the Ionicons renderer coffee and milk looked the same (cafe-outline).
  milk: { sf: "mug", md: "glass_cup", ion: "pint-outline" },
  juice: { sf: "carrot", md: "nutrition", ion: "nutrition-outline" },
  energy: { sf: "bolt", md: "bolt", ion: "flash-outline" },
  preworkout: { sf: "dumbbell", md: "fitness_center", ion: "barbell-outline" },
  alcohol: { sf: "wineglass", md: "wine_bar", ion: "wine-outline" },
  drinkOther: { sf: "waterbottle", md: "local_drink", ion: "beaker-outline" },
  health: { sf: "heart", md: "favorite", ion: "heart-outline" },
  photo: { sf: "photo", md: "image", ion: "image-outline" },
  /** Choose from the photo library. */
  photoLibrary: { sf: "photo.on.rectangle", md: "photo_library", ion: "images-outline" },
  /** Retake a photo or switch the camera. */
  retake: {
    sf: "arrow.triangle.2.circlepath.camera",
    md: "flip_camera_ios",
    ion: "camera-reverse-outline",
  },
  /** Read a nutrition label (text); `scan` is the barcode. */
  scanText: { sf: "text.viewfinder", md: "document_scanner", ion: "scan-outline" },
  swap: { sf: "arrow.left.arrow.right", md: "swap_horiz", ion: "swap-horizontal" },
  /** Superset: exercises linked into one block. */
  link: { sf: "link", md: "link", ion: "link-outline" },
  warmUp: { sf: "flame", md: "local_fire_department", ion: "flame-outline" },
  /** Reorder in a list (`move` is "move to" another day or meal). */
  moveUp: { sf: "arrow.up", md: "arrow_upward", ion: "arrow-up" },
  moveDown: { sf: "arrow.down", md: "arrow_downward", ion: "arrow-down" },
  /** Log again, run again. */
  repeat: { sf: "repeat", md: "repeat", ion: "repeat" },
  /** Build or adjust a program. */
  tools: { sf: "wrench.and.screwdriver", md: "build", ion: "construct-outline" },
  document: { sf: "doc.text", md: "description", ion: "document-text-outline" },
  travel: { sf: "airplane", md: "flight", ion: "airplane-outline" },
  stop: { sf: "stop.circle", md: "stop_circle", ion: "stop-circle-outline" },
  mic: { sf: "mic", md: "mic", ion: "mic-outline" },
  copy: { sf: "doc.on.doc", md: "content_copy", ion: "copy-outline" },
  bookmark: { sf: "bookmark", md: "bookmark", ion: "bookmark-outline" },
  today: { sf: "calendar.circle", md: "today", ion: "today-outline" },
  flag: { sf: "flag", md: "flag", ion: "flag-outline" },
  options: { sf: "slider.horizontal.3", md: "tune", ion: "options-outline" },
  refresh: { sf: "arrow.clockwise", md: "refresh", ion: "refresh" },
  download: { sf: "square.and.arrow.down", md: "download", ion: "download-outline" },
  /** Empty selection circle; `done` is the selected one. */
  unselected: { sf: "circle", md: "radio_button_unchecked", ion: "ellipse-outline" },
  /** Step on the scale (a weigh-in); `weight` is the body-weight metric. */
  scale: { sf: "scalemass", md: "scale", ion: "scale-outline" },
  help: { sf: "questionmark.circle", md: "help", ion: "help-circle-outline" },
} satisfies Record<string, IconSpec>;

export type IconName = keyof typeof icons;

let byIon: Partial<Record<IoniconsName, IconName>> | undefined;

/**
 * A registry key, or the first registry key whose Ionicons glyph matches (chevron-forward → forward, which then
 * mirrors in RTL; trash-outline → delete). undefined when the glyph has no semantic entry. Used by the shims.
 */
export function resolveIcon(name: IconName | IoniconsName): IconName | undefined {
  if (Object.prototype.hasOwnProperty.call(icons, name)) return name as IconName;
  if (!byIon) {
    byIon = {};
    for (const [key, spec] of Object.entries(icons) as [IconName, IconSpec][])
      byIon[spec.ion] ??= key;
  }
  return byIon[name as IoniconsName];
}

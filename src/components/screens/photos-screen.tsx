import { useState } from "react";
import { Alert, Image, Pressable, View, useWindowDimensions } from "react-native";
import { SystemButton, SystemText as Text } from "@/components/system";
import { Tabs } from "heroui-native";
import { Timeline } from "heroui-native-pro";
import * as ImagePicker from "expo-image-picker";
import { Directory, File, Paths } from "expo-file-system";
import { eq } from "drizzle-orm";
import { db, photos, type ProgressPhoto } from "@/db";
import { useStore } from "@/lib/store";
import { dayOf, localDay, validDay } from "@/lib/metrics";
import { Choices, DateInput, Editor, ErrorText, Screen } from "@/components/ui";

type Pose = ProgressPhoto["pose"];
const filters = ["all", "front", "side", "back"] as const;
export function PhotosScreen() {
  const { photos: records, t, date, refresh } = useStore();
  const [filter, setFilter] = useState<Pose | "all">("all");
  const [pose, setPose] = useState<Pose>("front");
  const [day, setDay] = useState(localDay());
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ProgressPhoto | null>(null);
  const [preview, setPreview] = useState<ProgressPhoto | null>(null);
  const { height } = useWindowDimensions();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [limit, setLimit] = useState(24);
  const visible = records.filter((p) => filter === "all" || p.pose === filter);
  const days = new Map<string, ProgressPhoto[]>();
  for (const photo of visible) {
    const photoDay = dayOf(photo.measuredAt);
    const group = days.get(photoDay);
    if (group) group.push(photo);
    else days.set(photoDay, [photo]);
  }
  const groups = [...days].sort(([a], [b]) => b.localeCompare(a));
  // Extend the page to include every photo on its final day.
  const shownGroups: typeof groups = [];
  let shownCount = 0;
  for (const group of groups) {
    if (shownCount >= limit) break;
    shownGroups.push(group);
    shownCount += group[1].length;
  }
  function launch(photo: ProgressPhoto | null) {
    setEditing(photo);
    setDay(photo ? dayOf(photo.measuredAt) : localDay());
    setPose(photo?.pose ?? (filter === "all" ? "front" : filter));
    setError("");
    setOpen(true);
  }
  async function save(source: "camera" | "library" = "library") {
    if (busy) return;
    if (!validDay(day)) {
      setError(t("invalidDate"));
      return;
    }
    setBusy(true);
    setError("");
    let copied: File | undefined;
    try {
      if (editing) {
        db.update(photos).set({ pose, measuredAt: day }).where(eq(photos.id, editing.id)).run();
      } else {
        if (source === "camera") {
          const permission = await ImagePicker.requestCameraPermissionsAsync();
          if (!permission.granted) {
            setError(t("cameraPermissionDenied"));
            return;
          }
        }
        const options: ImagePicker.ImagePickerOptions = {
          mediaTypes: ["images"],
          quality: 0.85,
          exif: false,
        };
        const result =
          source === "camera"
            ? await ImagePicker.launchCameraAsync(options)
            : await ImagePicker.launchImageLibraryAsync(options);
        if (result.canceled) return;
        const asset = result.assets[0];
        const directory = new Directory(Paths.document, "progress-photos");
        directory.create({ idempotent: true, intermediates: true });
        const extension = asset.uri.split(".").at(-1)?.split("?")[0]?.toLowerCase();
        const safeExtension = extension && /^[a-z0-9]{2,5}$/.test(extension) ? extension : "jpg";
        copied = new File(
          directory,
          `${Date.now()}-${Math.random().toString(36).slice(2)}.${safeExtension}`
        );
        new File(asset.uri).copy(copied);
        // Store only the basename: iOS may change the app container path after an update.
        db.insert(photos).values({ uri: copied.name, pose, measuredAt: day }).run();
      }
      refresh();
      setOpen(false);
    } catch {
      if (copied?.exists) copied.delete();
      setError(t("error"));
    } finally {
      setBusy(false);
    }
  }
  function remove() {
    if (!editing) return;
    Alert.alert(t("delete"), t("deleteConfirm"), [
      { text: t("cancel"), style: "cancel" },
      {
        text: t("delete"),
        style: "destructive",
        onPress: () => {
          try {
            const file = photoFile(editing);
            db.transaction((tx) => {
              tx.delete(photos).where(eq(photos.id, editing.id)).run();
              if (file.exists) file.delete();
            });
            refresh();
            setOpen(false);
          } catch {
            refresh();
            setError(t("error"));
          }
        },
      },
    ]);
  }
  return (
    <>
      <Screen title={t("photos")} subtitle={`${t("cadence")}: ${t("weekly")} – ${t("monthly")}`}>
        <Text className="text-muted">{t("localPhotos")}</Text>
        <SystemButton onPress={() => launch(null)}>
          {t("add")} · {t("photos")}
        </SystemButton>
        <Tabs
          value={filter}
          onValueChange={(value) => {
            const next = filters.find((option) => option === value);
            if (next) {
              setFilter(next);
              setLimit(24);
            }
          }}
          variant="secondary"
          className="gap-6"
        >
          <Tabs.List className="self-start max-w-full">
            <Tabs.ScrollView>
              <Tabs.Indicator />
              {filters.map((value) => (
                <Tabs.Trigger key={value} value={value}>
                  <Tabs.Label>{t(value)}</Tabs.Label>
                </Tabs.Trigger>
              ))}
            </Tabs.ScrollView>
          </Tabs.List>
          <Tabs.Content value={filter} className="gap-6">
            {!visible.length ? (
              <Text className="py-8 text-center text-muted">{t("photoEmpty")}</Text>
            ) : (
              <Timeline size="sm">
                {shownGroups.map(([photoDay, photos], index) => (
                  <Timeline.Item key={photoDay} status={index === 0 ? "current" : "default"}>
                    <Timeline.Rail />
                    <Timeline.Content className="min-w-0 gap-3">
                      <Timeline.Title className="font-mono text-sm">
                        {date(photoDay)}
                      </Timeline.Title>
                      <View className="-mx-1 flex-row flex-wrap gap-y-3" style={{ maxWidth: 744 }}>
                        {photos.map((photo) => (
                          <View key={photo.id} className="px-1" style={{ width: "33.333333%" }}>
                            <Pressable
                              className="min-w-0 gap-2 rounded-lg border border-transparent focus:border-focus"
                              accessibilityRole="button"
                              accessibilityLabel={`${t("photos")} · ${t(photo.pose)} · ${date(photo.measuredAt)}`}
                              onPress={() => setPreview(photo)}
                            >
                              <Image
                                source={{ uri: photoFile(photo).uri }}
                                className="rounded-lg"
                                style={{ width: "100%", aspectRatio: 0.7 }}
                                resizeMode="cover"
                                accessibilityLabel={t(photo.pose)}
                              />
                              <Text className="font-medium text-foreground">{t(photo.pose)}</Text>
                            </Pressable>
                          </View>
                        ))}
                      </View>
                    </Timeline.Content>
                  </Timeline.Item>
                ))}
              </Timeline>
            )}
            {visible.length > shownCount && (
              <SystemButton variant="ghost" onPress={() => setLimit(shownCount + 24)}>
                {t("photos")} +24
              </SystemButton>
            )}
          </Tabs.Content>
        </Tabs>
      </Screen>
      <Editor
        title={
          preview
            ? `${t(preview.pose)} · ${date(preview.measuredAt)}`
            : `${t(editing ? "edit" : "add")} · ${t("photos")}`
        }
        open={open || preview !== null}
        close={() => {
          setOpen(false);
          setPreview(null);
        }}
        busy={busy}
      >
        {preview ? (
          <>
            <Image
              source={{ uri: photoFile(preview).uri }}
              style={{ width: "100%", height: height * 0.65 }}
              resizeMode="contain"
              accessibilityLabel={`${t(preview.pose)} · ${date(preview.measuredAt)}`}
            />
            <SystemButton
              variant="secondary"
              onPress={() => {
                const photo = preview;
                setPreview(null);
                launch(photo);
              }}
            >
              {t("edit")}
            </SystemButton>
          </>
        ) : (
          <>
            <DateInput label={t("date")} value={day} onChange={setDay} disabled={busy} />
            <Choices values={["front", "side", "back"] as const} value={pose} onChange={setPose} />
            {editing && (
              <Image
                source={{ uri: photoFile(editing).uri }}
                style={{ width: "100%", height: 360 }}
                resizeMode="contain"
                accessibilityLabel={t(editing.pose)}
              />
            )}
            <ErrorText message={error} />
            {!editing && (
              <SystemButton onPress={() => save("camera")} isDisabled={busy}>
                {t("takePhoto")}
              </SystemButton>
            )}
            <SystemButton
              onPress={() => save()}
              variant={editing ? "primary" : "secondary"}
              isDisabled={busy}
            >
              {t(editing ? "save" : "choosePhoto")}
            </SystemButton>
            {editing && (
              <SystemButton variant="danger-soft" onPress={remove}>
                {t("delete")}
              </SystemButton>
            )}
          </>
        )}
      </Editor>
    </>
  );
}
function photoFile(photo: ProgressPhoto) {
  return new File(Paths.document, "progress-photos", photo.uri);
}

import { useRef, useState } from "react";
import { Linking, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as ImagePicker from "expo-image-picker";
import { File, Paths } from "expo-file-system";
import { SystemButton, SystemText as Text } from "@/components/system";
import { useStore } from "@/lib/store";

// What each kind of photo asks for, whole sentences so each language orders its own words.
const copy = {
  meal: {
    allow: "allowCameraMeal",
    unavailable: "cameraUnavailableMeal",
    take: "takePhotoOfMeal",
  },
  label: {
    allow: "allowCameraLabel",
    unavailable: "cameraUnavailableLabel",
    take: "takePhotoOfLabel",
  },
} as const;

/** Photos are only needed until they are read; the camera or picker copy is deleted after. */
export function discardPhoto(uri: string | null) {
  if (!uri) return;
  try {
    const file = new File(uri);
    if (file.uri.startsWith(`${Paths.cache.uri.replace(/\/$/, "")}/`) && file.exists) file.delete();
  } catch {
    // A leftover cache file is cleared by the system.
  }
}

/** An in-sheet camera with a library fallback, for meals and nutrition labels. */
export function PhotoCapture({
  kind,
  onPhoto,
  onError,
}: {
  /** What to photograph: a meal (or describe it instead) or a label (or type its values). */
  kind: keyof typeof copy;
  onPhoto: (uri: string) => void;
  onError: (message: string) => void;
}) {
  const { t } = useStore();
  const [permission, requestPermission] = useCameraPermissions();
  const [broken, setBroken] = useState(false);
  const [taking, setTaking] = useState(false);
  const camera = useRef<CameraView>(null);
  async function choose() {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        quality: 0.8,
        allowsEditing: false,
      });
      if (!result.canceled && result.assets[0]) onPhoto(result.assets[0].uri);
    } catch {
      onError(t("couldNotOpenPhotos"));
    }
  }
  async function take() {
    if (taking) return;
    setTaking(true);
    try {
      const picture = await camera.current?.takePictureAsync({ quality: 0.8 });
      if (picture?.uri) onPhoto(picture.uri);
    } catch {
      onError(t("couldNotTakePhoto"));
    } finally {
      setTaking(false);
    }
  }
  const library = (
    <SystemButton variant="secondary" icon="photoLibrary" onPress={() => void choose()}>
      {t("choosePhoto")}
    </SystemButton>
  );
  if (!permission) return <Text className="text-muted">{t("checkingCamera")}</Text>;
  if (!permission.granted || broken)
    return (
      <View className="gap-3">
        <Text className="text-muted">{t(broken ? copy[kind].unavailable : copy[kind].allow)}</Text>
        {!broken && (
          <SystemButton
            variant="secondary"
            icon="camera"
            onPress={() => {
              void (permission.canAskAgain ? requestPermission() : Linking.openSettings()).catch(
                () => setBroken(true)
              );
            }}
          >
            {t(permission.canAskAgain ? "allowCamera" : "openCameraSettings")}
          </SystemButton>
        )}
        {library}
      </View>
    );
  return (
    <View className="gap-2">
      {/* The preview fills its frame by cropping, so the frame has the photo's own portrait 3:4
          shape: what is in view is what the photo holds, and nothing past its edges. A 1pt
          keyline and a 4pt corner keep a white photo apart from the white sheet. */}
      <View className="overflow-hidden rounded-control border border-border">
        <CameraView
          ref={camera}
          style={{ width: "100%", aspectRatio: 3 / 4 }}
          facing="back"
          onMountError={() => setBroken(true)}
        />
      </View>
      <View className="flex-row gap-2">
        <SystemButton
          className="flex-1"
          icon="camera"
          isDisabled={taking}
          accessibilityLabel={t(copy[kind].take)}
          onPress={() => void take()}
        >
          {t(taking ? "taking" : "takePhoto")}
        </SystemButton>
        {library}
      </View>
    </View>
  );
}

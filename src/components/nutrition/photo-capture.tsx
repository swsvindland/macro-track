import { useRef, useState } from "react";
import { Linking, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as ImagePicker from "expo-image-picker";
import { File, Paths } from "expo-file-system";
import { SystemButton, SystemText as Text } from "@/components/system";

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
  subject,
  alternative,
  onPhoto,
  onError,
}: {
  /** What to photograph, e.g. "your meal". */
  subject: string;
  /** Another way to continue when there is no camera, e.g. "describe your meal". */
  alternative?: string;
  onPhoto: (uri: string) => void;
  onError: (message: string) => void;
}) {
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
      onError("Couldn't open your photos.");
    }
  }
  async function take() {
    if (taking) return;
    setTaking(true);
    try {
      const picture = await camera.current?.takePictureAsync({ quality: 0.8 });
      if (picture?.uri) onPhoto(picture.uri);
    } catch {
      onError("Couldn't take the photo. Try again or choose one from your library.");
    } finally {
      setTaking(false);
    }
  }
  const library = (
    <SystemButton variant="secondary" icon="images-outline" onPress={() => void choose()}>
      Choose photo
    </SystemButton>
  );
  if (!permission) return <Text className="text-muted">Checking camera access…</Text>;
  if (!permission.granted || broken)
    return (
      <View className="gap-3">
        <Text className="text-muted">
          {broken
            ? `The camera is unavailable. Choose a photo${alternative ? ` or ${alternative}` : ""}.`
            : `Allow camera access to photograph ${subject}, or choose a photo you already took.`}
        </Text>
        {!broken && (
          <SystemButton
            variant="secondary"
            icon="camera-outline"
            onPress={() => {
              void (permission.canAskAgain ? requestPermission() : Linking.openSettings()).catch(
                () => setBroken(true)
              );
            }}
          >
            {permission.canAskAgain ? "Allow camera" : "Open camera settings"}
          </SystemButton>
        )}
        {library}
      </View>
    );
  return (
    <View className="gap-2">
      {/* The preview fills its frame by cropping, so the frame has the photo's own portrait 3:4
          shape: what is in view is what the photo holds, and nothing past its edges. */}
      <CameraView
        ref={camera}
        style={{ width: "100%", aspectRatio: 3 / 4, borderRadius: 16, overflow: "hidden" }}
        facing="back"
        onMountError={() => setBroken(true)}
      />
      <View className="flex-row gap-2">
        <SystemButton
          className="flex-1"
          icon="camera"
          isDisabled={taking}
          accessibilityLabel={`Take photo of ${subject}`}
          onPress={() => void take()}
        >
          {taking ? "Taking…" : "Take photo"}
        </SystemButton>
        {library}
      </View>
    </View>
  );
}

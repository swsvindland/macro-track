import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo";
import { describeJson, extractJson, type JsonSchema } from "./model-json";
import type { TextBox } from "./nutrition-label";

export type ModelStatus = {
  state: "available" | "downloadable" | "downloading" | "unavailable";
  engine: "apple" | "gemini-nano" | "none";
  /** Photos can be analyzed, not only descriptions. */
  vision: boolean;
  /** Why the model can't run: old system, ineligible phone, turned off, still installing, or a build without the module. */
  reason?: "os" | "device" | "disabled" | "not-ready" | "unsupported" | "missing";
  detail?: string;
};

export type GenerateRequest = {
  instructions: string;
  prompt: string;
  schema: JsonSchema;
  imageUri?: string;
  maxTokens?: number;
};

type NativeLocalAI = {
  getStatus(): Promise<ModelStatus>;
  download(): Promise<void>;
  prewarm(): Promise<void>;
  generate(
    instructions: string,
    prompt: string,
    schema: string,
    imageUri: string | null,
    maxTokens: number
  ): Promise<string>;
  recognizeText(imageUri: string): Promise<TextBox[]>;
};

// Expo Go and builds from before this module simply report the feature as unavailable.
const native = requireOptionalNativeModule<NativeLocalAI>("LocalAI");

export async function modelStatus(): Promise<ModelStatus> {
  if (!native) return { state: "unavailable", engine: "none", vision: false, reason: "missing" };
  try {
    return await native.getStatus();
  } catch (e) {
    return {
      state: "unavailable",
      engine: "none",
      vision: false,
      reason: "unsupported",
      detail: e instanceof Error ? e.message : "",
    };
  }
}

/** Text recognition needs only this build's module, not Apple Intelligence or Gemini Nano. */
export const textRecognitionAvailable = () => !!native;

/** Reads the text in a photo on the phone (Vision on iOS, ML Kit on Android). */
export async function recognizeText(imageUri: string): Promise<TextBox[]> {
  if (!native) throw new Error("Text recognition isn't available in this build.");
  return native.recognizeText(imageUri);
}

/** Gemini Nano is installed by Android's AICore on request; Apple installs its model itself. */
export async function downloadModel() {
  if (native) await native.download();
}

/** Loads the model while the person frames the photo, so analysis starts sooner. */
export function prewarmModel() {
  void native?.prewarm().catch(() => {});
}

export function errorCode(error: unknown) {
  return typeof error === "object" && error && "code" in error ? String(error.code) : "";
}

/** Runs one on-device request and returns the parsed JSON reply. Nothing leaves the phone. */
export async function generateJson(request: GenerateRequest): Promise<unknown> {
  if (!native) throw new Error("On-device AI isn't available in this build.");
  // Apple decodes against the schema; Gemini Nano is told the shape in the prompt instead.
  const prompt =
    Platform.OS === "android"
      ? `${request.prompt}\n\n${describeJson(request.schema)}`
      : request.prompt;
  for (let attempt = 0; ; attempt++) {
    try {
      const text = await native.generate(
        request.instructions,
        prompt,
        JSON.stringify(request.schema),
        request.imageUri ?? null,
        request.maxTokens ?? 800
      );
      return extractJson(text);
    } catch (e) {
      // A busy model usually frees up within a second or two.
      if (errorCode(e) === "ERR_LOCAL_AI_BUSY" && attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 900 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
}

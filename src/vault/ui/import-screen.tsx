// The Restore screen, /vault/import (docs/vault.md, "Restore"; spec §8.5, §11.6). It reads a file — picked here, a
// recovery set handed over by Settings, and from M2 a file opened from another app, a cloud download or a handoff —
// shows what it holds next to what this device has now, asks before replacing anything, restores and says what
// happened. The flow and its work live in ui/use-vault.ts, so a running restore survives the app going to the
// background; while it runs, leaving the screen is blocked (swipe back, header back, Android back).
import { Stack, useNavigation } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Alert, BackHandler } from "react-native";

import {
  Button,
  Callout,
  DetailScreen,
  ErrorText,
  Field,
  Heading,
  Meta,
  Note,
  Panel,
  ProcessLine,
  useKitFormat,
  useKitStrings,
} from "@/vector";

import { vaultApp } from "../app";
import { useVaultRefresh } from "../app-ui";
import { useVaultText } from "../i18n";
import type { DescribeContext, Preview, SummaryValues } from "../types";

import { repairCount, summaryDate, type ImportState } from "./import-flow";
import { deviceNoun, errorText, stepKey } from "./labels";
import { leaveVault } from "./nav";
import { recoveryCreatedAt } from "./recovery";
import {
  attachImportScreen,
  cancelRestore,
  confirmRestore,
  firstSight,
  openNextImport,
  pickImportFile,
  requestRestore,
  unlockImport,
  useImportFlow,
} from "./use-vault";

export default function ImportScreen() {
  const { v, when } = useVaultText();
  const strings = useKitStrings();
  const refresh = useVaultRefresh();
  const navigation = useNavigation();
  const state = useImportFlow();
  const restoring = state.s === "restoring";

  useEffect(() => attachImportScreen(), []);

  // The app re-reads its stores once per restore, with the callback it got while rendering.
  useEffect(() => {
    if (state.s === "done" && firstSight(state.result)) refresh();
  }, [state, refresh]);

  useEffect(() => {
    if (state.s !== "confirm" || !firstSight(state)) return;
    const date = when(state.preview.createdAt);
    // Separate paragraphs, each its own key: never a sentence joined from parts.
    const body = [
      v(state.preview.format === "legacy" ? "confirmBodyLegacy" : "confirmBody", { date }),
      state.healthOn ? v("confirmHealthOff") : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    // vector: irreversible
    Alert.alert(
      v("confirmTitle"),
      body,
      [
        { text: strings.cancel, style: "cancel", onPress: cancelRestore },
        { text: v("confirmAction"), style: "destructive", onPress: confirmRestore },
      ],
      { cancelable: true, onDismiss: cancelRestore }
    );
  }, [state, strings, v, when]);

  useEffect(() => {
    if (!restoring) return;
    const back = BackHandler.addEventListener("hardwareBackPress", () => true);
    const leave = navigation.addListener("beforeRemove", (e) => e.preventDefault());
    return () => {
      back.remove();
      leave();
    };
  }, [navigation, restoring]);

  const header = useMemo(
    () => ({
      gestureEnabled: !restoring,
      headerBackVisible: !restoring,
      headerLeft: restoring ? () => null : undefined,
    }),
    [restoring]
  );

  return (
    <DetailScreen title={v("importTitle")}>
      <Stack.Screen options={header} />
      <Body state={state} />
    </DetailScreen>
  );
}

function Body({ state }: { state: ImportState }) {
  const { v, when } = useVaultText();
  switch (state.s) {
    case "start":
      return (
        <>
          <Note>{v("importIntro")}</Note>
          <Button icon="document" onPress={() => void pickImportFile()}>
            {v("chooseFile")}
          </Button>
        </>
      );
    case "reading":
      return <ProcessLine label={v("reading")} />;
    case "password":
      return <PasswordForm unlocking={state.unlocking} wrong={state.error} />;
    case "preview":
    case "confirm":
      return <PreviewView preview={state.preview} confirming={state.s === "confirm"} />;
    case "restoring":
      return (
        <>
          <Heading level={2}>{v("previewTitle", { date: when(state.preview.createdAt) })}</Heading>
          <ProcessLine
            label={v(stepKey(state.step))}
            done={state.percent ?? undefined}
            total={state.percent === null ? undefined : 100}
          />
        </>
      );
    case "done":
      return <DoneView state={state} />;
    case "error":
      return (
        <>
          <ErrorText message={errorText(v, { code: state.code, info: state.info }, "manual")} />
          {state.origin === "file" || state.origin === null ? (
            <Button variant="secondary" icon="document" onPress={() => void pickImportFile()}>
              {v("chooseFile")}
            </Button>
          ) : null}
          <NextFile queued={!!state.next} />
        </>
      );
  }
}

/** A legacy encrypted backup: its password, tried with the same file (the field is cleared when this closes). */
function PasswordForm({ unlocking, wrong }: { unlocking: boolean; wrong: boolean }) {
  const { v } = useVaultText();
  const [password, setPassword] = useState("");
  const unlock = () => {
    if (password) unlockImport(password);
  };
  return (
    <>
      <Heading level={3}>{v("passwordTitle")}</Heading>
      <Note>{v("passwordBody")}</Note>
      <Field
        label={v("passwordField")}
        value={password}
        onChange={setPassword}
        secure
        autoFocus
        disabled={unlocking}
        onSubmit={unlock}
      />
      <Button
        loading={unlocking}
        loadingLabel={v("unlocking")}
        disabled={!password}
        onPress={unlock}
      >
        {v("unlock")}
      </Button>
      {unlocking ? <Note>{v("unlockingNote")}</Note> : null}
      <ErrorText message={wrong ? errorText(v, "legacyPasswordWrong", "manual") : ""} />
    </>
  );
}

/** What the file holds next to what this device has now, the notes that apply, and Restore. */
function PreviewView({ preview, confirming }: { preview: Preview; confirming: boolean }) {
  const { language, v, vp, when } = useVaultText();
  const format = useKitFormat();
  const describe = useMemo(() => {
    const ctx: DescribeContext = {
      language,
      plural: (n) => format.plural(n),
      number: (n) => format.number(n),
      date: (value) => format.date(summaryDate(value), "medium"),
    };
    return (values: SummaryValues) => vaultApp.describe(values, ctx);
  }, [language, format]);
  const date = when(preview.createdAt);
  // Standalone Meta items, never inside a sentence.
  const madeOn = [
    preview.device ? deviceNoun(v, preview.device) : "",
    preview.appVersion ? v("previewMadeWith", { version: preview.appVersion }) : "",
  ];
  const notes = [
    preview.olderSchema ? v("previewOlder") : "",
    preview.crossPlatform
      ? v(preview.device?.platform === "ios" ? "previewFromIos" : "previewFromAndroid")
      : "",
    preview.format === "legacy" ? v("previewLegacy") : "",
    preview.sourceHealthSyncOn ? v("previewHealthOtherDevice") : "",
    preview.media.missing > 0 ? vp("previewMediaMissing", preview.media.missing) : "",
  ].filter(Boolean);
  return (
    <>
      <Heading level={2}>{v("previewTitle", { date })}</Heading>
      {madeOn.some(Boolean) ? <Meta items={madeOn} /> : null}
      <Panel>
        <Panel.Header title={v("previewInBackup")} />
        <Panel.Body>
          <Meta items={describe(preview.incoming)} />
        </Panel.Body>
      </Panel>
      <Panel>
        <Panel.Header title={v("previewOnDevice")} />
        <Panel.Body>
          <Meta items={describe(preview.current)} />
        </Panel.Body>
      </Panel>
      {preview.newerLocalChanges ? (
        <Callout tone="warning">{v("previewNewerChanges", { date })}</Callout>
      ) : null}
      {notes.map((note) => (
        <Note key={note}>{note}</Note>
      ))}
      <Button variant="destructive" disabled={confirming} onPress={requestRestore}>
        {v("restoreButton")}
      </Button>
    </>
  );
}

/** What the restore did: the data's date, Health, warnings, photos it could not restore, repairs, and the undo. */
function DoneView({ state }: { state: Extract<ImportState, { s: "done" }> }) {
  const { v, vp, when } = useVaultText();
  const { result, preview } = state;
  const repairs = repairCount(result);
  const undoFrom = result.recoveryId ? recoveryCreatedAt(result.recoveryId) : null;
  return (
    <>
      <Heading level={2}>{v("restoredTitle")}</Heading>
      <Note>{v("restoredBody", { date: when(preview.createdAt) })}</Note>
      {result.healthWasOn ? <Callout tone="warning">{v("restoredHealthOff")}</Callout> : null}
      {result.warning ? <Callout tone="warning">{v("restoredWithWarnings")}</Callout> : null}
      {result.mediaSkipped > 0 ? (
        <Note>{vp("restoredMediaSkipped", result.mediaSkipped)}</Note>
      ) : null}
      {repairs > 0 ? <Note>{vp("restoredRepairs", repairs)}</Note> : null}
      {undoFrom ? <Note>{v("restoredUndo", { date: when(undoFrom) })}</Note> : null}
      <Button onPress={leaveVault}>{v("backToSettings")}</Button>
      <NextFile queued={!!state.next} />
    </>
  );
}

/** A file that arrived while the restore ran: opened when the person asks. */
function NextFile({ queued }: { queued: boolean }) {
  const { v } = useVaultText();
  if (!queued) return null;
  return (
    <Button variant="secondary" onPress={openNextImport}>
      {v("restoreButton")}
    </Button>
  );
}

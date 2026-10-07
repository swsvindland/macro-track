// <VaultSection /> (docs/vault.md, "Wiring a repo"; spec §11.3, §11.5): the Backup rows of each app's Settings.
// Export data runs in place (progress, then the share sheet on iOS, or Save to device and Share on Android); Restore
// from a file opens /vault/import; "Restore data from before {date}" opens the newest recovery set there while one
// exists. Development builds (or the plugin option `selftest: true`) add the vault self-test. M2 (T2.6) adds the
// automatic backup and cloud rows, M3 the handoff row. Renders nothing where the native module is missing.
import { useEffect, useState, useSyncExternalStore } from "react";
import { View } from "react-native";

import {
  Button,
  Callout,
  ErrorText,
  ListRow,
  Note,
  Panel,
  ProcessLine,
  SettingsSection,
  Status,
} from "@/vector";

import {
  runSelfTest,
  SELF_TEST_TITLE,
  selfTestAvailable,
  selfTestState,
  subscribeSelfTest,
  type SelfTestResult,
  type SelfTestState,
} from "../dev/selftest";
import { useVaultText } from "../i18n";
import { vaultSupported } from "../native";

import { useExport, type Exporter } from "./export";
import { errorText, stepKey } from "./labels";
import { goVault } from "./nav";
import { openRecoveryFlow, visibleRecovery } from "./recovery";
import { refreshVaultStatus, useVaultStatus } from "./use-vault";

export function VaultSection() {
  const { v, when } = useVaultText();
  const status = useVaultStatus();
  const exporter = useExport();
  const check = useSyncExternalStore(subscribeSelfTest, selfTestState);
  // When Settings opened: the recovery row's time window (M2) is measured from here.
  const [now] = useState(Date.now);
  useEffect(() => {
    void refreshVaultStatus();
  }, []);

  if (!vaultSupported) return null;
  const recovery = visibleRecovery(status, now);
  const working = exporter.busy || exporter.saving;
  const selfTest = selfTestAvailable();
  return (
    <View className="gap-3">
      <SettingsSection eyebrow={v("sectionTitle")} footnote={v("sectionFootnote")}>
        <ListRow
          icon="share"
          title={v("exportRow")}
          description={v("exportRowHint")}
          trailing="none"
          disabled={working}
          onPress={() => void exporter.run()}
        />
        <ListRow
          icon="download"
          title={v("importRow")}
          disabled={working}
          onPress={() => goVault("import")}
        />
        {recovery ? (
          <ListRow
            icon="undo"
            title={v("undoRestoreRow", { date: when(recovery.createdAt) })}
            disabled={working}
            onPress={() => void openRecoveryFlow(recovery.id)}
          />
        ) : null}
        {selfTest ? (
          <ListRow
            icon="refresh"
            title={SELF_TEST_TITLE}
            trailing="none"
            disabled={check.running}
            onPress={() => void runSelfTest()}
          />
        ) : null}
      </SettingsSection>
      {exporter.busy ? (
        <ProcessLine
          label={v(stepKey(exporter.progress.step))}
          done={exporter.progress.done}
          total={exporter.progress.total}
        />
      ) : null}
      {exporter.ready ? <ExportReady exporter={exporter} /> : null}
      {exporter.warnings ? <Callout tone="warning">{v("exportWarning")}</Callout> : null}
      <ErrorText message={exporter.error ? errorText(v, exporter.error, "manual") : ""} />
      {selfTest ? <SelfTestPanel check={check} /> : null}
    </View>
  );
}

/** Android, after an export: Save to device (the dependable path) or Share. */
function ExportReady({ exporter }: { exporter: Exporter }) {
  const { v } = useVaultText();
  return (
    <View className="gap-3">
      <Note>{v("exportReady")}</Note>
      <Button
        icon="download"
        loading={exporter.saving}
        onPress={() => void exporter.saveToDevice()}
      >
        {v("saveToDevice")}
      </Button>
      <Button
        variant="secondary"
        icon="share"
        disabled={exporter.saving}
        onPress={() => void exporter.share()}
      >
        {v("shareFile")}
      </Button>
      {exporter.savedTo ? <Note>{v("savedTo", { folder: exporter.savedTo })}</Note> : null}
    </View>
  );
}

const outcomeState = { pass: "ok", fail: "error", skip: "off" } as const;

/** The self-test's results, one line per case (development tooling). */
function SelfTestPanel({ check }: { check: SelfTestState }) {
  const { v } = useVaultText();
  if (!check.running && !check.results.length) return null;
  return (
    <Panel>
      <Panel.Header eyebrow={SELF_TEST_TITLE} />
      <Panel.Body>
        {check.results.map((result) => (
          <SelfTestLine key={result.id} result={result} />
        ))}
        {check.running ? <ProcessLine label={v("statusChecking")} /> : null}
      </Panel.Body>
    </Panel>
  );
}

function SelfTestLine({ result }: { result: SelfTestResult }) {
  return (
    <View className="gap-1">
      <Status
        state={outcomeState[result.outcome]}
        label={result.label}
        meta={`${result.outcome} ${result.ms} ms`}
      />
      {result.detail ? <Note>{result.detail}</Note> : null}
    </View>
  );
}

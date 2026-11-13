import React, { useMemo, useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { Stack } from 'expo-router';
import { maglevEngine } from 'maglev-engine';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, spacing, type } from '../../constants/theme';
import { Banner, Button, ListRow, Toggle } from '../../components/ui';
import { Caption, Card, SettingsPage } from '../../components/settings/SettingsParts';
import { backupCopy as copy } from '../../constants/copy';
import { relativeTime } from '../../utils/feeds';
import { applyBackup, exportBackup, getLastBackupAt, pickBackup } from '../../utils/backup/io';
import { BACKUP_PARTS, previewCounts, previewSentence, type Backup, type BackupPart } from '../../utils/backup/format';
import { startAdded, type RestoreResult } from '../../utils/backup/import';

type Step =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'preview'; backup: Backup; parts: BackupPart[]; confirming: boolean }
  | { kind: 'done'; result: RestoreResult; started: number | null };

/** The parts a backup actually holds, so an empty one is not offered. */
function availableParts(b: Backup): BackupPart[] {
  const p = previewCounts(b);
  return BACKUP_PARTS.filter((part) => {
    switch (part) {
      case 'settings':
        return p.hasSettings;
      case 'search':
        return p.searchSources > 0;
      case 'feeds':
        return p.feeds > 0 || b.prefs['maglev.feeds.automation.v1'] !== undefined;
      case 'schedule':
        return p.hasSchedule;
      case 'assistant':
        return p.hasAssistant;
      case 'torrents':
        return p.torrents > 0;
      case 'downloads':
        return p.downloads > 0;
    }
  });
}

export default function BackupSettings() {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [lastAt, setLastAt] = useState(getLastBackupAt);

  const doExport = async () => {
    setMessage(null);
    setStep({ kind: 'busy' });
    const res = await exportBackup();
    setStep({ kind: 'idle' });
    if ('cancelled' in res) return;
    if (res.ok) {
      setLastAt(getLastBackupAt());
      setMessage({ tone: 'success', text: copy.exportDone(res.fileName) });
    } else {
      setMessage({ tone: 'danger', text: copy.exportFailed });
    }
  };

  const doPick = async () => {
    setMessage(null);
    setStep({ kind: 'busy' });
    const res = await pickBackup();
    if ('cancelled' in res) return setStep({ kind: 'idle' });
    if (!res.ok) {
      setStep({ kind: 'idle' });
      return setMessage({ tone: 'danger', text: copy.readFailed });
    }
    if (!res.result.ok) {
      setStep({ kind: 'idle' });
      return setMessage({ tone: 'danger', text: res.result.message });
    }
    const backup = res.result.backup;
    setStep({ kind: 'preview', backup, parts: availableParts(backup), confirming: false });
  };

  const doRestore = async (backup: Backup, parts: BackupPart[]) => {
    setStep({ kind: 'busy' });
    const result = await applyBackup(backup, new Set(parts));
    setStep({ kind: 'done', result, started: null });
  };

  const onRestore = (st: Extract<Step, { kind: 'preview' }>) => {
    if (st.parts.includes('settings') && !st.confirming) return setStep({ ...st, confirming: true });
    void doRestore(st.backup, st.parts);
  };

  const startAll = async (st: Extract<Step, { kind: 'done' }>) => {
    const started = await startAdded(st.result, maglevEngine);
    setStep({ ...st, started });
  };

  return (
    <SettingsPage title={copy.title}>
      <Stack.Screen options={{ headerShown: false }} />
      {message ? <Banner tone={message.tone} title={message.text} onDismiss={() => setMessage(null)} /> : null}

      {step.kind === 'idle' || step.kind === 'busy' ? (
        <>
          <Card>
            <ListRow
              icon="upload"
              title={copy.export.title}
              subtitle={copy.export.subtitle}
              onPress={step.kind === 'busy' ? undefined : doExport}
              disabled={step.kind === 'busy'}
            />
            <ListRow
              icon="download"
              title={copy.restore.title}
              subtitle={copy.restore.subtitle}
              onPress={step.kind === 'busy' ? undefined : doPick}
              disabled={step.kind === 'busy'}
            />
          </Card>
          <Caption>{lastAt ? copy.last(relativeTime(lastAt)) : copy.never}</Caption>
          <Caption>{copy.secrets}</Caption>
          <Caption>{copy.notIncluded}</Caption>
        </>
      ) : null}

      {step.kind === 'preview' ? (
        <>
          <Text style={s.lead}>{previewSentence(previewCounts(step.backup))}</Text>
          <Caption>{copy.partsHeader}</Caption>
          <Card>
            {availableParts(step.backup).map((part) => (
              <ListRow
                key={part}
                title={copy.parts[part]}
                accessory={
                  <Toggle
                    value={step.parts.includes(part)}
                    accessibilityLabel={copy.parts[part]}
                    onValueChange={(on) =>
                      setStep({
                        ...step,
                        confirming: false,
                        parts: on ? [...step.parts, part] : step.parts.filter((p) => p !== part),
                      })
                    }
                  />
                }
              />
            ))}
          </Card>
          {step.parts.includes('torrents') || step.parts.includes('downloads') ? <Caption>{copy.torrentsNote}</Caption> : null}
          {step.confirming ? (
            <Banner tone="warning" title={copy.settingsConfirm.title} body={copy.settingsConfirm.body} />
          ) : null}
          <Button
            label={step.confirming ? copy.settingsConfirm.action : copy.restoreAction}
            variant={step.confirming ? 'danger' : 'primary'}
            disabled={step.parts.length === 0}
            onPress={() => onRestore(step)}
          />
          <Button label="Cancel" variant="ghost" onPress={() => setStep({ kind: 'idle' })} />
        </>
      ) : null}

      {step.kind === 'busy' ? <Caption>{copy.restoring}</Caption> : null}

      {step.kind === 'done' ? <Done st={step} onStart={() => startAll(step)} onClose={() => setStep({ kind: 'idle' })} /> : null}
    </SettingsPage>
  );
}

function Done({ st, onStart, onClose }: { st: Extract<Step, { kind: 'done' }>; onStart: () => void; onClose: () => void }) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const r = st.result;
  const lines: string[] = [];
  if (r.torrentsAdded + r.torrentsSkipped + r.torrentsFailed > 0) {
    lines.push(`Torrents: ${copy.added(r.torrentsAdded)}${r.torrentsSkipped ? `, ${copy.skipped(r.torrentsSkipped)}` : ''}${r.torrentsFailed ? `, ${copy.failed(r.torrentsFailed)}` : ''}.`);
  }
  if (r.downloadsAdded + r.downloadsSkipped + r.downloadsFailed > 0) {
    lines.push(`Downloads: ${copy.added(r.downloadsAdded)}${r.downloadsSkipped ? `, ${copy.skipped(r.downloadsSkipped)}` : ''}${r.downloadsFailed ? `, ${copy.failed(r.downloadsFailed)}` : ''}.`);
  }
  if (r.defaultFolderCount > 0) lines.push(`${copy.defaultFolder(r.defaultFolderCount)}.`);
  const addedAny = r.addedTorrentIds.length + r.addedDownloadIds.length > 0;
  return (
    <>
      <Banner tone="success" title={copy.doneTitle} />
      {lines.map((l) => (
        <Text key={l} style={s.lead}>
          {l}
        </Text>
      ))}
      <Caption>{copy.restartNote}</Caption>
      {addedAny && st.started === null ? <Button label={copy.startAll} onPress={onStart} /> : null}
      {st.started !== null ? <Caption>{copy.started(st.started)}</Caption> : null}
      <Button label={copy.done} variant="ghost" onPress={onClose} />
    </>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    lead: { ...type.body, color: c.text, paddingHorizontal: spacing.xs },
  });

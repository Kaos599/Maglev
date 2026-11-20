import React, { useEffect, useMemo, useState } from 'react';
import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import Constants from 'expo-constants';
import { getBlocklistInfo, type BlocklistInfo } from 'maglev-engine';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import { useTheme } from '../../context/ThemeContext';
import { Button, ListRow, RadioCard, SectionHeader, Sheet, Toggle } from '../../components/ui';
import { Caption, Card, SettingsPage } from '../../components/settings/SettingsParts';
import { highlightCopy, listsCopy, updateCopy } from '../../constants/copy';
import { updateInfoOf, useHasUpdate } from '../../components/settings/updates/useHasUpdate';
import { plainNotes } from '../../utils/update/check';
import type { UpdateState } from '../../utils/update/machine';
import {
  checkNow,
  dismissDownloadFailure,
  downloadNow,
  firstUpdateAsks,
  getManagedBy,
  getManagedCheck,
  getUpdateState,
  installNow,
  openInstallPermission,
  skipThisVersion,
} from '../../utils/update';
import { useUpdatePrefs } from '../../utils/prefs/update';
import { useListPrefs } from '../../utils/prefs/lists';
import { checkListsNow, useListsState } from '../../utils/lists';
import { adBusy, sourcesBusy, type AdState, type SourcesState } from '../../utils/lists/machine';
import { relativeTime } from '../../utils/feeds';
import type { PixelIconName } from '../../components/PixelIcon';

const WHEN_FOUND = 'When an update is found';
const LISTS_CAPTION = 'Ad block list, search sources and trackers. Updated without an app update.';

const MODE_ICONS: Record<'ask' | 'download' | 'auto', PixelIconName> = { ask: 'bell', download: 'download', auto: 'retry' };

/** The result line under the "Search sources and trackers" row (contract 31.3), or null before any check. */
function sourcesResult(st: SourcesState): string | null {
  switch (st.kind) {
    case 'checking':
    case 'verifying':
      return listsCopy.checking;
    case 'unchanged':
      return listsCopy.values.upToDate;
    case 'applied':
      return st.changed > 0 ? listsCopy.values.updatedSources(st.changed) : listsCopy.values.updated;
    case 'rejected':
      return listsCopy.hints.rejected;
    case 'failed':
      return st.why === 'blocked' ? listsCopy.hints.blocked : listsCopy.values.failed;
    default:
      return null;
  }
}

/** The result line under the "Ad block list" row, or null before any check or when the automatic check skipped it. */
function adResult(st: AdState): string | null {
  switch (st.kind) {
    case 'downloading':
      return listsCopy.checking;
    case 'notModified':
      return listsCopy.values.upToDate;
    case 'updated':
      return listsCopy.values.updated;
    case 'failed':
      return st.why === 'blocked' ? listsCopy.hints.blocked : st.why === 'invalid' ? listsCopy.hints.rejected : listsCopy.values.failed;
    default:
      return null;
  }
}

/** What went wrong, in plain English, from the engine code. */
function failureText(code: string): string {
  const n = updateCopy.notices;
  if (code === 'UPDATE_INVALID') return n.invalid;
  if (code === 'STORAGE_FULL') return n.storageFull;
  if (code === 'BLOCKED') return n.blocked;
  return code === 'INSTALL_FAILED' || code === 'INSTALL_CANCELLED' ? n.installFailed : n.downloadFailed;
}

export default function UpdatesSettings() {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const [cardOpen, setCardOpen] = useState(false);
  const appVersion = Constants.expoConfig?.version ?? '—';
  const { update, managedCheck, info, newerManaged, hasUpdate } = useHasUpdate();
  const [prefs, setPrefs] = useUpdatePrefs();
  const managedBy = getManagedBy();
  const lists = useListsState();
  const [listPrefs, setListPrefs] = useListPrefs();
  const [adInfo, setAdInfo] = useState<BlocklistInfo | null>(null);
  const listsChecking = sourcesBusy(lists) || adBusy(lists);

  // The ad list facts come from native; read them again after each check.
  useEffect(() => {
    let alive = true;
    void getBlocklistInfo().then((r) => {
      if (alive && r.ok) setAdInfo(r);
    });
    return () => {
      alive = false;
    };
  }, [lists.ad]);

  const adLine = adInfo
    ? adInfo.updatedAt != null
      ? listsCopy.adList.info(adInfo.domains.toLocaleString(), relativeTime(adInfo.updatedAt))
      : listsCopy.adList.builtIn(adInfo.domains.toLocaleString())
    : null;
  const sourcesStamp = listPrefs.sourcesFile ? Date.parse(listPrefs.sourcesFile.generatedAt) || listPrefs.lastListCheckAt : null;
  const sourcesLine =
    listPrefs.appliedSerial > 0 && sourcesStamp ? listsCopy.sources.updated(relativeTime(sourcesStamp)) : listsCopy.sources.builtIn;
  const lines = (...parts: (string | null)[]) => parts.filter(Boolean).join('\n');

  const checking = update.kind === 'checking' || managedCheck.status === 'checking';

  const checkValue = checking
    ? updateCopy.check.checking
    : update.kind === 'upToDate' || managedCheck.status === 'upToDate'
      ? updateCopy.check.upToDate
      : update.kind === 'checkFailed' || managedCheck.status === 'failed'
        ? updateCopy.check.failed
        : undefined;

  // Only a check this tap started opens the card (a check that was already running, or an automatic one, doesn't).
  const runCheck = () => {
    void checkNow({ manual: true }).then((started) => {
      if (!started) return;
      const st = getUpdateState();
      if ((updateInfoOf(st) && st.kind !== 'done') || getManagedCheck().status === 'newer') setCardOpen(true);
    });
  };

  return (
    <SettingsPage title="Updates">
      <Stack.Screen options={{ headerShown: false }} />
      <SectionHeader title="App" />
      <Card>
        <ListRow
          title="App version"
          value={hasUpdate ? undefined : appVersion}
          accessory={
            hasUpdate ? (
              <View style={s.versionEnd}>
                <Text style={s.versionText}>{appVersion}</Text>
                <View style={s.badge} accessible accessibilityLabel={updateCopy.versionBadge}>
                  <Text style={s.badgeText}>{updateCopy.versionBadge}</Text>
                </View>
              </View>
            ) : undefined
          }
        />
        {hasUpdate ? (
          <ListRow
            title={updateCopy.available((info?.version ?? newerManaged?.version) as string)}
            subtitle={managedBy ? updateCopy.managedBy(managedBy) : undefined}
            icon="download"
            onPress={() => (newerManaged ? void Linking.openURL(newerManaged.pageUrl) : setCardOpen(true))}
          />
        ) : (
          <ListRow
            title={updateCopy.check.title}
            icon="retry"
            value={checkValue}
            disabled={checking}
            onPress={runCheck}
          />
        )}
        {managedBy ? (
          <ListRow title={updateCopy.updatesRow.title} subtitle={updateCopy.managedBy(managedBy)} />
        ) : (
          <>
            <View style={s.block} accessibilityRole="radiogroup" accessibilityLabel={updateCopy.updatesRow.title}>
              <Text style={s.label}>{WHEN_FOUND}</Text>
              {updateCopy.modes.map((m) => (
                <RadioCard
                  key={m.value}
                  title={m.title}
                  icon={MODE_ICONS[m.value]}
                  description={m.description}
                  selected={prefs.updateMode === m.value}
                  onPress={() => prefs.updateMode !== m.value && setPrefs({ updateMode: m.value })}
                  accessibilityLabel={`${m.title}. ${m.description}`}
                />
              ))}
            </View>
            <ListRow
              title={updateCopy.updatesRow.autoCheck}
              subtitle={updateCopy.updatesRow.autoCheckHint}
              accessory={
                <Toggle
                  value={prefs.updateAutoCheck}
                  onValueChange={(updateAutoCheck) => setPrefs({ updateAutoCheck })}
                  accessibilityLabel={updateCopy.updatesRow.autoCheck}
                />
              }
            />
          </>
        )}
        <ListRow
          title={highlightCopy.settingTitle}
          subtitle={highlightCopy.settingSubtitle}
          accessory={
            <Toggle
              value={prefs.showHighlights}
              onValueChange={(showHighlights) => setPrefs({ showHighlights })}
              accessibilityLabel={highlightCopy.settingTitle}
            />
          }
        />
      </Card>
      <SectionHeader title="Lists" />
      <Caption>{LISTS_CAPTION}</Caption>
      <Card>
        <ListRow
          title={listsCopy.autoUpdate}
          subtitle={listsCopy.hints.autoUpdateSubtitle}
          accessory={
            <Toggle
              value={listPrefs.listsAutoCheck}
              onValueChange={(listsAutoCheck) => setListPrefs({ listsAutoCheck })}
              accessibilityLabel={listsCopy.autoUpdate}
            />
          }
        />
        <ListRow
          title={listsCopy.adList.title}
          subtitle={lines(adLine, adResult(lists.ad))}
          accessory={
            <Button
              label={listsCopy.checkNow}
              variant="secondary"
              loading={listsChecking}
              onPress={() => void checkListsNow()}
              accessibilityLabel={`${listsCopy.checkNow}: ${listsCopy.adList.title}`}
            />
          }
        />
        <ListRow
          title={listsCopy.sources.title}
          subtitle={lines(sourcesLine, sourcesResult(lists.sources))}
          accessory={
            <Button
              label={listsCopy.checkNow}
              variant="secondary"
              loading={listsChecking}
              onPress={() => void checkListsNow()}
              accessibilityLabel={`${listsCopy.checkNow}: ${listsCopy.sources.title}`}
            />
          }
        />
      </Card>
      <Sheet
        visible={cardOpen && info !== null}
        onClose={() => setCardOpen(false)}
        title={info ? updateCopy.card.title(info.version) : ''}
      >
        {info ? <UpdateCard state={update} notes={info.notes} onClose={() => setCardOpen(false)} /> : null}
      </Sheet>
    </SettingsPage>
  );
}

function UpdateCard({ state, notes, onClose }: { state: UpdateState; notes: string; onClose: () => void }) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const text = plainNotes(notes);
  const c = updateCopy.card;

  const status = (() => {
    switch (state.kind) {
      case 'downloading': {
        const pct = state.total > 0 ? Math.min(100, Math.floor((state.bytes / state.total) * 100)) : null;
        return pct === null ? c.downloading : `${c.downloading} ${pct}%`;
      }
      case 'waitingForWifi':
        return c.waitingForWifi;
      case 'installing':
        return c.installing;
      case 'needsUser':
        return c.confirm;
      case 'downloadFailed':
      case 'installFailed':
        return failureText(state.code);
      case 'needsPermission':
        return updateCopy.notices.needsPermission;
      default:
        return null;
    }
  })();
  const failed = state.kind === 'downloadFailed' || state.kind === 'installFailed';
  const canInstall = state.kind === 'ready' || state.kind === 'readyAsk' || state.kind === 'installFailed' || state.kind === 'needsUser';
  const canDownload = state.kind === 'available' || state.kind === 'waiting' || state.kind === 'waitingForWifi';
  const canSkip = canDownload || canInstall;

  return (
    <View style={s.cardBody}>
      <Text style={s.label}>{c.whatsNew}</Text>
      <ScrollView style={s.notes} nestedScrollEnabled>
        <Text style={s.notesText}>{text || c.noNotes}</Text>
      </ScrollView>
      {status ? <Text style={[s.status, failed && { color: colors.danger }]}>{status}</Text> : null}
      {canInstall || state.kind === 'installing' ? <Caption>{updateCopy.notices.restartWarning}</Caption> : null}
      {canInstall && firstUpdateAsks() ? <Caption>{updateCopy.hints.firstUpdate}</Caption> : null}
      <View style={s.actions}>
        {state.kind === 'needsPermission' ? (
          <Button label={c.allowInstalls} onPress={() => void openInstallPermission()} />
        ) : null}
        {canInstall ? <Button label={state.kind === 'installFailed' ? c.retry : c.install} onPress={() => void installNow()} /> : null}
        {canDownload ? <Button label={c.download} onPress={() => void downloadNow()} /> : null}
        {state.kind === 'downloadFailed' ? (
          <Button
            label={c.retry}
            onPress={() => {
              void downloadNow();
            }}
          />
        ) : null}
        <Button
          label={c.later}
          variant="ghost"
          onPress={() => {
            if (state.kind === 'downloadFailed') dismissDownloadFailure();
            onClose();
          }}
        />
        {canSkip ? (
          <Button
            label={c.skip}
            variant="ghost"
            onPress={() => {
              skipThisVersion();
              onClose();
            }}
          />
        ) : null}
      </View>
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    block: { padding: spacing.lg, gap: spacing.sm },
    label: { ...type.bodyStrong, fontSize: type.size.base, color: c.text },
    versionEnd: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    versionText: { ...type.body, fontSize: type.size.base, color: c.textMuted },
    badge: { backgroundColor: c.accent, borderRadius: radius.sm, paddingHorizontal: spacing.sm, paddingVertical: 2 },
    badgeText: { ...type.bodyStrong, fontSize: type.size.sm, color: c.onAccent },
    cardBody: { gap: spacing.md },
    notes: { maxHeight: 200 },
    notesText: { ...type.body, fontSize: type.size.base, color: c.textMuted },
    status: { ...type.body, fontSize: type.size.base, color: c.text },
    actions: { gap: spacing.sm },
  });

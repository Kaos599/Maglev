import { Linking, Platform } from 'react-native';
import Constants from 'expo-constants';
import { buildIssueUrl, deviceLabel } from './check';

/** Phone details for the bug form (Android only; other platforms send what they have). */
function phoneDetails() {
  const c = (Platform.constants ?? {}) as { Release?: string; Model?: string; Manufacturer?: string };
  const device = deviceLabel(c.Manufacturer, c.Model);
  return { android: String(c.Release ?? Platform.Version ?? ''), device };
}

/** Opens the bug form with version and phone filled in. Settings > About > Report a bug and the video link caption share it. */
export function openBugReport(): void {
  const { android, device } = phoneDetails();
  void Linking.openURL(buildIssueUrl({ version: Constants.expoConfig?.version ?? '', android, device }));
}

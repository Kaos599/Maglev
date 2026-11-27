import { useEffect } from 'react';
import { AppState, Linking } from 'react-native';
import { useRouter, type Href } from 'expo-router';
import { redirectSystemPath } from '../app/+native-intent';
import { appPath } from '../utils/browserUrl';
import { onShareWaiting } from '../modules/maglev-engine/src/MaglevQuickShare';
import { dropPendingShare, takeSharedLink } from '../utils/shareHandoff';

/**
 * Opens a link the share card left while the app was already running. At start the same link is read by the start-up
 * routing (app/+native-intent.tsx), so this only catches a link that arrives later: it looks on mount, every time
 * the app comes back to the front, and whenever the card says it left one (the app can stay resumed in split-screen, so
 * an app-state change is not enough). Renders nothing.
 */
export function ShareHandoff() {
  const router = useRouter();
  useEffect(() => {
    const open = () => {
      const link = takeSharedLink();
      if (!link) return;
      // The same routing a shared link always had, so every kind of link lands on the same screen as before.
      router.navigate(appPath(redirectSystemPath({ path: link, initial: false })) as Href);
    };
    open();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') open();
    });
    const waiting = onShareWaiting(open);
    // A link that reaches the app another way while it runs is newer than one waiting in the store: drop that one.
    const url = Linking.addEventListener('url', dropPendingShare);
    return () => {
      sub.remove();
      waiting();
      url.remove();
    };
  }, [router]);
  return null;
}

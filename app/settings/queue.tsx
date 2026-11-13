import { Redirect } from 'expo-router';

/** Old route: Torrents & queue moved into Speed & queue. Kept so links and deep links still land. */
export default function QueueRedirect() {
  return <Redirect href={'/settings/speed' as never} />;
}

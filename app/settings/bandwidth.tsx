import { Redirect } from 'expo-router';

/** Old route: Bandwidth moved into Speed & queue. Kept so links and deep links still land. */
export default function BandwidthRedirect() {
  return <Redirect href={'/settings/speed' as never} />;
}

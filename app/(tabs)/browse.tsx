// The Browser tab. /browser stays a stack screen for pushes and deep links; this route is
// the same screen shown inside the tab bar (its own name, so /browser still means the stack one).
import BrowserScreen from '../browser';

export default function BrowseTab() {
  return <BrowserScreen inTab />;
}

export { ErrorBoundary } from '../../components/ErrorScreen';

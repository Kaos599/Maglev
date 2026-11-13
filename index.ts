// App entry. The watch task must be defined in the global scope, before the router starts, so Android can run it
// in a background (headless) JS run where no screen is ever rendered. docs/contracts-0.19/watch.md section 2.
import './utils/watch/task';
import 'expo-router/entry';

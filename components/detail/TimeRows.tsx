import { StyleSheet, View } from 'react-native';
import { spacing } from '../../constants/theme';
import { timeRowsCopy } from '../../constants/copy';
import { fullWhen } from '../../utils/stats/format';
import { ListRow } from '../ui';

/**
 * "Started" (when it was added) and "Finished" (when it first completed), as two info rows on a detail screen.
 * Times come from the engine (`addedAt`, `finishedAt`, unix seconds). A time the engine does not
 * know (an item added by an older version, or one not finished yet) hides its row instead of showing a guess.
 */
export function TimeRows({ addedAt, finishedAt }: { addedAt?: number; finishedAt?: number }) {
  const started = fullWhen(addedAt);
  const finished = fullWhen(finishedAt);
  if (!started && !finished) return null;
  return (
    <View style={styles.stack}>
      {started ? <ListRow title={timeRowsCopy.started} value={started} icon="calendar" /> : null}
      {finished ? <ListRow title={timeRowsCopy.finished} value={finished} icon="clock" /> : null}
    </View>
  );
}

const styles = StyleSheet.create({ stack: { gap: spacing.sm } });

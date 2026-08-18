import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { type LabelData } from '@/services/printer';

interface Props {
  label: LabelData;
}

/**
 * Visual preview of the label as it will appear on 12 mm × ~50 mm tape
 * from the Core Tech N12 printer.
 *
 * The N12 feeds tape horizontally; the 12 mm dimension is the tape height.
 * We render it rotated — landscape strip — exactly as the tape looks
 * after it's peeled and applied to a card sleeve or binder page.
 */
export function PrintLabel({ label }: Props) {
  // Truncate to fit 12 mm tape at readable sizes
  const name   = label.cardName.length > 20 ? label.cardName.slice(0, 18) + '…' : label.cardName;
  const series = label.series.length  > 22 ? label.series.slice(0, 20)  + '…' : label.series;

  return (
    <View style={styles.outer}>
      {/* Tape spool edge — top */}
      <View style={styles.tapeEdge} />

      {/* Label body — landscape strip */}
      <View style={styles.labelStrip}>
        {/* Left accent bar */}
        <View style={styles.accentBar} />

        {/* Label content */}
        <View style={styles.content}>
          <Text style={styles.cardName} numberOfLines={1}>{name.toUpperCase()}</Text>
          <View style={styles.row}>
            <Text style={styles.series} numberOfLines={1}>{series}</Text>
            <Text style={styles.value}>{label.value}</Text>
          </View>
        </View>
      </View>

      {/* Tape spool edge — bottom */}
      <View style={styles.tapeEdge} />

      {/* Cut mark */}
      <View style={styles.cutRow}>
        <View style={styles.cutDash} />
        <View style={styles.cutMarker}>
          <Text style={styles.cutText}>✂</Text>
        </View>
        <View style={styles.cutDash} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  outer: {
    alignSelf: 'stretch',
    // subtle card shadow simulating the tape printer output
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.22,
    shadowRadius: 8,
    elevation: 5,
    marginVertical: 4,
  },
  tapeEdge: {
    height: 6,
    backgroundColor: '#C8C2B0',
    borderTopLeftRadius: 3,
    borderTopRightRadius: 3,
  },
  labelStrip: {
    flexDirection: 'row',
    alignItems: 'stretch',
    backgroundColor: '#FAFAF5',
    minHeight: 52,
  },
  accentBar: {
    width: 4,
    backgroundColor: '#1A1A2E',
  },
  content: {
    flex: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    justifyContent: 'center',
    gap: 4,
  },
  cardName: {
    fontFamily: 'Courier New',
    fontSize: 12,
    fontWeight: 'bold' as const,
    color: '#111',
    letterSpacing: 0.5,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  series: {
    fontFamily: 'Courier New',
    fontSize: 9,
    color: '#555',
    flex: 1,
    marginRight: 8,
  },
  value: {
    fontFamily: 'Courier New',
    fontSize: 11,
    fontWeight: 'bold' as const,
    color: '#222',
  },
  cutRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#C8C2B0',
    height: 14,
    paddingHorizontal: 4,
  },
  cutDash: {
    flex: 1,
    height: 1,
    backgroundColor: '#888',
    marginHorizontal: 4,
  },
  cutMarker: {
    paddingHorizontal: 4,
  },
  cutText: {
    fontSize: 10,
    color: '#555',
  },
});

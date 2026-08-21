import React, { useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import Svg, { Rect } from 'react-native-svg';
import { encode128B } from '@/services/barcode';

interface Props {
  /** The string to encode — typically the card's numeric ID */
  value: string;
  /** Height of the barcode bars in pixels */
  height?: number;
  /** Width of one barcode unit in pixels */
  unitWidth?: number;
  /** Bar color */
  color?: string;
}

export function Barcode({
  value,
  height = 28,
  unitWidth = 1.4,
  color = '#111111',
}: Props) {
  const widths = useMemo(() => encode128B(value), [value]);

  const totalWidth = widths.reduce((s, w) => s + w * unitWidth, 0);

  let x = 0;
  const bars: React.ReactNode[] = [];

  widths.forEach((w, i) => {
    const px = w * unitWidth;
    if (i % 2 === 0) {
      // Even index = bar (dark)
      bars.push(
        <Rect
          key={i}
          x={x}
          y={0}
          width={px}
          height={height}
          fill={color}
        />
      );
    }
    // Odd index = space (transparent — background shows through)
    x += px;
  });

  return (
    <View style={styles.container}>
      <Svg width={totalWidth} height={height}>
        {bars}
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});

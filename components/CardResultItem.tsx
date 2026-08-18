import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { type CardProduct, getBestPrice } from '@/services/pricecharting';

interface Props {
  item: CardProduct;
  onPress: () => void;
}

export function CardResultItem({ item, onPress }: Props) {
  const colors = useColors();

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={[
        styles.container,
        { backgroundColor: colors.card, borderColor: colors.border },
      ]}
    >
      <View style={styles.info}>
        <Text
          style={[
            styles.name,
            { color: colors.foreground, fontFamily: 'Inter_600SemiBold' },
          ]}
          numberOfLines={1}
        >
          {item['product-name']}
        </Text>
        <Text
          style={[
            styles.series,
            { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' },
          ]}
          numberOfLines={1}
        >
          {item['console-name']}
        </Text>
      </View>
      <View style={styles.right}>
        <Text
          style={[
            styles.price,
            { color: colors.primary, fontFamily: 'Inter_700Bold' },
          ]}
        >
          {getBestPrice(item)}
        </Text>
        <Feather name="chevron-right" size={16} color={colors.mutedForeground} />
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    marginHorizontal: 16,
    marginBottom: 8,
    borderRadius: 12,
    borderWidth: 1,
  },
  info: { flex: 1, marginRight: 12 },
  name: { fontSize: 15, marginBottom: 3 },
  series: { fontSize: 12 },
  right: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  price: { fontSize: 16 },
});

import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import { formatPrice } from '@/services/pricecharting';
import { type LabelData, sendToPrinter } from '@/services/printer';
import { addHistoryEntry } from '@/services/history';
import { PrintLabel } from '@/components/PrintLabel';

export default function CardDetailScreen() {
  const colors = useColors();
  const params = useLocalSearchParams<{
    id: string;
    name: string;
    series: string;
    loose: string;
    cib: string;
    newPrice: string;
    graded: string;
  }>();

  const [printing, setPrinting] = useState(false);
  const [printed, setPrinted] = useState(false);

  const looseCents   = parseInt(params.loose    ?? '0', 10);
  const cibCents     = parseInt(params.cib      ?? '0', 10);
  const newCents     = parseInt(params.newPrice ?? '0', 10);
  const gradedCents  = parseInt(params.graded   ?? '0', 10);

  const bestValue = looseCents || cibCents || newCents || gradedCents;

  const label: LabelData = {
    cardName: params.name   ?? '',
    series:   params.series ?? '',
    value:    formatPrice(bestValue),
  };

  const prices = [
    { label: 'Loose',  cents: looseCents  },
    { label: 'CIB',    cents: cibCents    },
    { label: 'New',    cents: newCents    },
    { label: 'Graded', cents: gradedCents },
  ].filter((p) => p.cents > 0);

  const handlePrint = async () => {
    if (printing) return;
    setPrinting(true);
    try {
      // Always save to history so it's tracked
      await addHistoryEntry({
        cardName: label.cardName,
        series:   label.series,
        value:    label.value,
      });

      // Attempt Bluetooth send (throws in Expo Go; works in native APK build)
      await sendToPrinter('', label);

      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setPrinted(true);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const isExpoGo = msg.includes('EXPO_GO_ONLY');

      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      setPrinted(true); // mark saved

      Alert.alert(
        isExpoGo ? 'Saved to History' : 'Print Error',
        isExpoGo
          ? 'Label saved to history.\n\nTo print via the Core Tech N12, build this app as an APK. See README for instructions.'
          : msg,
        [{ text: 'OK' }],
      );
    } finally {
      setPrinting(false);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          Platform.OS === 'web' && { paddingBottom: 34 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* Card header */}
        <View
          style={[
            styles.cardHeader,
            { backgroundColor: colors.card, borderColor: colors.border },
          ]}
        >
          <Text
            style={[
              styles.cardName,
              { color: colors.foreground, fontFamily: 'Inter_700Bold' },
            ]}
          >
            {params.name}
          </Text>
          <Text
            style={[
              styles.seriesText,
              { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' },
            ]}
          >
            {params.series}
          </Text>
          <Text
            style={[
              styles.bestPrice,
              { color: colors.primary, fontFamily: 'Inter_700Bold' },
            ]}
          >
            {formatPrice(bestValue)}
          </Text>
        </View>

        {/* Price breakdown */}
        {prices.length > 0 && (
          <View
            style={[
              styles.pricesCard,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}
          >
            <Text
              style={[
                styles.sectionLabel,
                { color: colors.mutedForeground, fontFamily: 'Inter_500Medium' },
              ]}
            >
              PRICE BREAKDOWN
            </Text>
            {prices.map((p, i) => (
              <View
                key={p.label}
                style={[
                  styles.priceRow,
                  i < prices.length - 1 && {
                    borderBottomWidth: 1,
                    borderBottomColor: colors.border,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.priceLabel,
                    { color: colors.foreground, fontFamily: 'Inter_400Regular' },
                  ]}
                >
                  {p.label}
                </Text>
                <Text
                  style={[
                    styles.priceValue,
                    { color: colors.foreground, fontFamily: 'Inter_600SemiBold' },
                  ]}
                >
                  {formatPrice(p.cents)}
                </Text>
              </View>
            ))}
          </View>
        )}

        {/* Label preview */}
        <View style={styles.previewSection}>
          <Text
            style={[
              styles.sectionLabel,
              { color: colors.mutedForeground, fontFamily: 'Inter_500Medium' },
            ]}
          >
            N12 LABEL PREVIEW · 12 mm × 40 mm
          </Text>
          <PrintLabel label={label} />
        </View>

        {/* Print button */}
        <TouchableOpacity
          style={[
            styles.printBtn,
            {
              backgroundColor: printed
                ? colors.secondary
                : printing
                ? colors.muted
                : colors.primary,
            },
          ]}
          onPress={handlePrint}
          activeOpacity={0.8}
          disabled={printing || printed}
        >
          {printing ? (
            <ActivityIndicator color={colors.primaryForeground} />
          ) : printed ? (
            <>
              <Feather name="check-circle" size={20} color={colors.primary} />
              <Text
                style={[
                  styles.printBtnText,
                  { color: colors.primary, fontFamily: 'Inter_600SemiBold' },
                ]}
              >
                Saved to History
              </Text>
            </>
          ) : (
            <>
              <Feather name="printer" size={20} color={colors.primaryForeground} />
              <Text
                style={[
                  styles.printBtnText,
                  {
                    color: colors.primaryForeground,
                    fontFamily: 'Inter_600SemiBold',
                  },
                ]}
              >
                Print Label
              </Text>
            </>
          )}
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { padding: 16, gap: 12, paddingBottom: 32 },
  cardHeader: {
    padding: 20,
    borderRadius: 14,
    borderWidth: 1,
    gap: 6,
  },
  cardName: { fontSize: 22, lineHeight: 28 },
  seriesText: { fontSize: 14 },
  bestPrice: { fontSize: 34, marginTop: 10 },
  pricesCard: {
    padding: 16,
    borderRadius: 14,
    borderWidth: 1,
  },
  sectionLabel: { fontSize: 11, letterSpacing: 0.8, marginBottom: 10 },
  priceRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 13,
  },
  priceLabel: { fontSize: 15 },
  priceValue: { fontSize: 15 },
  previewSection: { gap: 10 },
  printBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 56,
    borderRadius: 14,
    gap: 10,
    marginTop: 6,
  },
  printBtnText: { fontSize: 17 },
});

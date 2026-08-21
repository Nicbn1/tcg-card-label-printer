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
  TextInput,
} from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import { formatPrice } from '@/services/pricecharting';
import { type LabelData, sendToPrinter } from '@/services/printer';
import { addHistoryEntry } from '@/services/history';
import { PrintLabel } from '@/components/PrintLabel';
import { LabelPresetPicker } from '@/components/LabelPresetPicker';
import {
  getDefaultCondition,
  getSelectedPriceCents,
  makeLabelData,
  PRICE_CONDITIONS,
  type PriceCondition,
} from '@/services/priceSelection';
import {
  DEFAULT_LABEL_PRESET,
  type LabelField,
  type LabelPresetId,
} from '@/services/labelPresets';

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
    stale?: string;
  }>();

  const [printing, setPrinting] = useState(false);
  const [printed, setPrinted] = useState(false);

  const looseCents   = parseInt(params.loose    ?? '0', 10);
  const cibCents     = parseInt(params.cib      ?? '0', 10);
  const newCents     = parseInt(params.newPrice ?? '0', 10);
  const gradedCents  = parseInt(params.graded   ?? '0', 10);

  const card = {
    cardId: params.id ?? undefined,
    cardName: params.name ?? '',
    series: params.series ?? '',
    loose: looseCents,
    cib: cibCents,
    newPrice: newCents,
    graded: gradedCents,
  };
  const [condition, setCondition] = useState<PriceCondition>(() => getDefaultCondition(card));
  const [customPrice, setCustomPrice] = useState('');
  const [preset, setPreset] = useState<LabelPresetId>(DEFAULT_LABEL_PRESET);
  const [customFields, setCustomFields] = useState<LabelField[]>([]);
  const selectedCents = getSelectedPriceCents(card, condition, customPrice);

  const label: LabelData = makeLabelData(
    card,
    condition,
    customPrice,
    undefined,
    preset,
    customFields,
    1,
    params.stale === '1',
  );

  const prices = [
    { label: 'Loose',  cents: looseCents  },
    { label: 'CIB',    cents: cibCents    },
    { label: 'New',    cents: newCents    },
    { label: 'Graded', cents: gradedCents },
  ].filter((p) => p.cents > 0);

  const handlePrint = async () => {
    if (printing) return;
    if (selectedCents <= 0) {
      Alert.alert(
        'Choose a valid price',
        condition === 'custom'
          ? 'Enter a custom price greater than $0.00 before printing.'
          : 'Choose a condition with a PriceCharting value or enter a custom price.',
      );
      return;
    }
    setPrinting(true);
    try {
      // Always save to history so it's tracked
        await addHistoryEntry({ ...label });

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
              {label.value}
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

        {/* Price condition */}
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
            LABEL PRICE
          </Text>
          <View style={styles.conditionGrid}>
            {PRICE_CONDITIONS.map((option) => (
              <TouchableOpacity
                key={option.key}
                onPress={() => {
                  setCondition(option.key);
                  setPrinted(false);
                }}
                style={[
                  styles.conditionOption,
                  {
                    backgroundColor: condition === option.key ? colors.primary : colors.accent,
                    borderColor: condition === option.key ? colors.primary : colors.border,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.conditionOptionText,
                    {
                      color: condition === option.key ? colors.primaryForeground : colors.foreground,
                      fontFamily: 'Inter_500Medium',
                    },
                  ]}
                >
                  {option.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          {condition === 'custom' && (
            <View
              style={[
                styles.customPriceInput,
                { backgroundColor: colors.background, borderColor: colors.border },
              ]}
            >
              <Text style={[styles.currency, { color: colors.mutedForeground }]}>$</Text>
              <TextInput
                value={customPrice}
                onChangeText={(value) => {
                  setCustomPrice(value);
                  setPrinted(false);
                }}
                keyboardType="decimal-pad"
                placeholder="0.00"
                placeholderTextColor={colors.mutedForeground}
                style={[
                  styles.customPriceText,
                  { color: colors.foreground, fontFamily: 'Inter_500Medium' },
                ]}
              />
            </View>
          )}
          <Text
            style={[
              styles.selectedPriceHint,
              { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' },
            ]}
          >
            {label.condition}: {label.value}
          </Text>
        </View>

        <View
          style={[
            styles.pricesCard,
            { backgroundColor: colors.card, borderColor: colors.border },
          ]}
        >
          <LabelPresetPicker
            preset={preset}
            customFields={customFields}
            onPresetChange={(nextPreset) => {
              setPreset(nextPreset);
              setPrinted(false);
            }}
            onCustomFieldsChange={(fields) => {
              setCustomFields(fields);
              setPrinted(false);
            }}
          />
        </View>

        {label.stale && (
          <View style={[styles.staleNotice, { backgroundColor: colors.accent, borderColor: colors.border }]}>
            <Feather name="wifi-off" size={16} color={colors.primary} />
            <Text style={[styles.staleText, { color: colors.foreground, fontFamily: 'Inter_500Medium' }]}>
              Saved offline price — this label is marked stale.
            </Text>
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
  conditionGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  conditionOption: {
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 9,
    paddingVertical: 7,
  },
  conditionOptionText: { fontSize: 12 },
  customPriceInput: {
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 9,
    paddingHorizontal: 12,
    marginTop: 12,
    gap: 3,
  },
  currency: { fontSize: 16 },
  customPriceText: { flex: 1, height: 44, fontSize: 16 },
  selectedPriceHint: { fontSize: 12, marginTop: 12 },
  previewSection: { gap: 10 },
  staleNotice: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 11,
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  staleText: { flex: 1, fontSize: 12, lineHeight: 17 },
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

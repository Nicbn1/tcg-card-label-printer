import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { useBatchQueue, type BatchQueueItem } from '@/context/BatchQueueContext';
import {
  getSelectedPriceCents,
  makeLabelData,
  PRICE_CONDITIONS,
  type PriceCondition,
} from '@/services/priceSelection';
import { addHistoryEntry } from '@/services/history';
import { sendToPrinter } from '@/services/printer';
import { formatPrice } from '@/services/pricecharting';
import { LabelPresetPicker } from '@/components/LabelPresetPicker';
import type { LabelField, LabelPresetId } from '@/services/labelPresets';

function QueueCard({
  item,
  onRemove,
  onCopy,
  onConditionChange,
  onCustomPriceChange,
  onPresetChange,
  onCustomFieldsChange,
}: {
  item: BatchQueueItem;
  onRemove: () => void;
  onCopy: () => void;
  onConditionChange: (condition: PriceCondition) => void;
  onCustomPriceChange: (value: string) => void;
  onPresetChange: (preset: LabelPresetId) => void;
  onCustomFieldsChange: (fields: LabelField[]) => void;
}) {
  const colors = useColors();
  const selectedPrice = getSelectedPriceCents(item, item.condition, item.customPrice);

  return (
    <View style={[styles.queueCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={styles.itemHeader}>
        <View style={styles.itemInfo}>
          <Text
            style={[styles.itemName, { color: colors.foreground, fontFamily: 'Inter_600SemiBold' }]}
            numberOfLines={1}
          >
            {item.cardName}
          </Text>
          <Text
            style={[styles.itemSeries, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}
            numberOfLines={1}
          >
            {item.series}
          </Text>
        </View>
        <Text style={[styles.itemPrice, { color: colors.primary, fontFamily: 'Inter_700Bold' }]}>
          {formatPrice(selectedPrice)}
        </Text>
      </View>

      <View style={styles.conditionGrid}>
        {PRICE_CONDITIONS.map((option) => (
          <TouchableOpacity
            key={option.key}
            onPress={() => onConditionChange(option.key)}
            style={[
              styles.conditionButton,
              {
                backgroundColor: item.condition === option.key ? colors.primary : colors.accent,
                borderColor: item.condition === option.key ? colors.primary : colors.border,
              },
            ]}
          >
            <Text
              style={[
                styles.conditionButtonText,
                {
                  color: item.condition === option.key ? colors.primaryForeground : colors.foreground,
                  fontFamily: 'Inter_500Medium',
                },
              ]}
            >
              {option.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {item.condition === 'custom' && (
        <View style={[styles.customInput, { borderColor: colors.border, backgroundColor: colors.background }]}>
          <Text style={[styles.currency, { color: colors.mutedForeground }]}>$</Text>
          <TextInput
            value={item.customPrice}
            onChangeText={onCustomPriceChange}
            keyboardType="decimal-pad"
            placeholder="0.00"
            placeholderTextColor={colors.mutedForeground}
            style={[styles.customInputText, { color: colors.foreground, fontFamily: 'Inter_500Medium' }]}
          />
        </View>
      )}

      <LabelPresetPicker
        compact
        preset={item.preset}
        customFields={item.customFields}
        onPresetChange={onPresetChange}
        onCustomFieldsChange={onCustomFieldsChange}
      />

      <View style={styles.itemActions}>
        <TouchableOpacity onPress={onCopy} style={styles.compactAction}>
          <Feather name="copy" size={15} color={colors.primary} />
          <Text style={[styles.compactActionText, { color: colors.primary, fontFamily: 'Inter_500Medium' }]}>
            Add copy
          </Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={onRemove} style={styles.compactAction}>
          <Feather name="trash-2" size={15} color={colors.destructive} />
          <Text
            style={[styles.compactActionText, { color: colors.destructive, fontFamily: 'Inter_500Medium' }]}
          >
            Remove
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

export default function BatchQueueScreen() {
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { items, addCopy, clearQueue, isReady, removeItem, updateItem } = useBatchQueue();
  const [printing, setPrinting] = useState(false);

  const handlePrintQueue = async () => {
    if (!items.length || printing) return;

    const invalidItem = items.find(
      (item) => getSelectedPriceCents(item, item.condition, item.customPrice) <= 0,
    );
    if (invalidItem) {
      Alert.alert(
        'Choose a price',
        `Add a valid price for ${invalidItem.cardName} before printing the queue.`,
      );
      return;
    }

    setPrinting(true);
    const failedItems: string[] = [];
    let savedForNativeBuild = 0;
    try {
      for (const item of items) {
        const label = makeLabelData(
          item,
          item.condition,
          item.customPrice,
          undefined,
          item.preset,
          item.customFields,
          item.quantity,
          item.stale,
        );
        await addHistoryEntry({ ...label });
        try {
          await sendToPrinter('', label);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes('EXPO_GO_ONLY')) {
            savedForNativeBuild += 1;
          } else {
            failedItems.push(item.queueId);
          }
        }
      }

      if (!failedItems.length) {
        clearQueue();
      } else {
        for (const queueId of items.map((item) => item.queueId)) {
          if (!failedItems.includes(queueId)) removeItem(queueId);
        }
      }
      await Haptics.notificationAsync(
        failedItems.length
          ? Haptics.NotificationFeedbackType.Warning
          : Haptics.NotificationFeedbackType.Success,
      );

      if (failedItems.length) {
        Alert.alert(
          'Some labels need retrying',
          `${failedItems.length} label${failedItems.length === 1 ? '' : 's'} could not be sent. They remain in the queue so you can retry after checking the printer connection.`,
        );
        return;
      }

      Alert.alert(
        savedForNativeBuild ? 'Queue Saved to History' : 'Queue Sent',
        savedForNativeBuild
          ? `${savedForNativeBuild} labels were saved in order. Build the Android APK to send the queue to your N12 printer.`
          : `${items.length} labels were sent to the printer in order.`,
      );
      router.replace('/');
    } catch (error: unknown) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      Alert.alert(
        'Queue Error',
        error instanceof Error ? error.message : 'Could not prepare this print queue.',
      );
    } finally {
      setPrinting(false);
    }
  };

  const handleClear = () => {
    Alert.alert('Clear queue?', 'Remove every card from the current batch?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear queue', style: 'destructive', onPress: clearQueue },
    ]);
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          { paddingBottom: Platform.OS === 'web' ? 34 : insets.bottom + 24 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <View style={[styles.summary, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={[styles.summaryIcon, { backgroundColor: colors.accent }]}>
            <Feather name="layers" size={20} color={colors.primary} />
          </View>
          <View style={styles.summaryText}>
            <Text style={[styles.summaryTitle, { color: colors.foreground, fontFamily: 'Inter_700Bold' }]}>
              Print queue
            </Text>
            <Text
              style={[styles.summaryBody, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}
            >
              {items.length
                ? `${items.length} label${items.length === 1 ? '' : 's'} ready to review`
                : 'Add cards from Search to build a batch'}
            </Text>
          </View>
          {items.length > 0 && (
            <TouchableOpacity onPress={handleClear} hitSlop={8}>
              <Feather name="trash-2" size={18} color={colors.destructive} />
            </TouchableOpacity>
          )}
        </View>

        {!isReady ? (
          <View style={styles.emptyState}>
            <ActivityIndicator color={colors.primary} />
            <Text style={[styles.emptyBody, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
              Restoring your print queue…
            </Text>
          </View>
        ) : items.length ? (
          <>
            <View style={styles.queueList}>
              {items.map((item, index) => (
                <View key={item.queueId} style={styles.queuedItem}>
                  <Text style={[styles.queueNumber, { color: colors.mutedForeground, fontFamily: 'Inter_600SemiBold' }]}>
                    {index + 1}
                  </Text>
                  <QueueCard
                    item={item}
                    onCopy={() => addCopy(item.queueId)}
                    onRemove={() => removeItem(item.queueId)}
                    onConditionChange={(condition) => updateItem(item.queueId, { condition })}
                    onCustomPriceChange={(customPrice) => updateItem(item.queueId, { customPrice })}
                    onPresetChange={(preset) => updateItem(item.queueId, { preset })}
                    onCustomFieldsChange={(customFields) => updateItem(item.queueId, { customFields })}
                  />
                </View>
              ))}
            </View>

            <TouchableOpacity
              style={[styles.printButton, { backgroundColor: printing ? colors.muted : colors.primary }]}
              onPress={handlePrintQueue}
              disabled={printing}
            >
              {printing ? (
                <ActivityIndicator color={colors.primaryForeground} />
              ) : (
                <>
                  <Feather name="printer" size={20} color={colors.primaryForeground} />
                  <Text style={[styles.printButtonText, { color: colors.primaryForeground, fontFamily: 'Inter_600SemiBold' }]}>
                    Print {items.length} label{items.length === 1 ? '' : 's'}
                  </Text>
                </>
              )}
            </TouchableOpacity>
          </>
        ) : (
          <View style={styles.emptyState}>
            <Feather name="camera" size={44} color={colors.mutedForeground} style={{ opacity: 0.35 }} />
            <Text style={[styles.emptyTitle, { color: colors.foreground, fontFamily: 'Inter_600SemiBold' }]}>
              Your queue is empty
            </Text>
            <Text style={[styles.emptyBody, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
              Search or scan cards, then use the plus button to add an exact match here.
            </Text>
            <TouchableOpacity
              onPress={() => router.replace('/')}
              style={[styles.backButton, { borderColor: colors.primary }]}
            >
              <Text style={[styles.backButtonText, { color: colors.primary, fontFamily: 'Inter_600SemiBold' }]}>
                Back to search
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { padding: 16, gap: 16 },
  summary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
  },
  summaryIcon: { width: 38, height: 38, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  summaryText: { flex: 1 },
  summaryTitle: { fontSize: 16 },
  summaryBody: { fontSize: 12, marginTop: 2 },
  queueList: { gap: 12 },
  queuedItem: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  queueNumber: { width: 18, fontSize: 13, paddingTop: 14, textAlign: 'center' },
  queueCard: { flex: 1, borderWidth: 1, borderRadius: 14, padding: 13, gap: 11 },
  itemHeader: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  itemInfo: { flex: 1 },
  itemName: { fontSize: 15 },
  itemSeries: { fontSize: 12, marginTop: 3 },
  itemPrice: { fontSize: 16 },
  conditionGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  conditionButton: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 9, paddingVertical: 6 },
  conditionButtonText: { fontSize: 12 },
  customInput: {
    height: 42,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 9,
    paddingHorizontal: 11,
    gap: 3,
  },
  currency: { fontSize: 15 },
  customInputText: { flex: 1, fontSize: 15, height: 42 },
  itemActions: { flexDirection: 'row', gap: 18 },
  compactAction: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  compactActionText: { fontSize: 12 },
  printButton: {
    height: 55,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    borderRadius: 14,
  },
  printButtonText: { fontSize: 16 },
  emptyState: { alignItems: 'center', paddingHorizontal: 26, paddingTop: 72, gap: 10 },
  emptyTitle: { fontSize: 18, marginTop: 4 },
  emptyBody: { fontSize: 14, lineHeight: 20, textAlign: 'center' },
  backButton: { marginTop: 8, borderWidth: 1, borderRadius: 9, paddingHorizontal: 16, paddingVertical: 10 },
  backButtonText: { fontSize: 14 },
});
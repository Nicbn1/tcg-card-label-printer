import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Alert,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { getHistory, clearHistory, type HistoryEntry } from '@/services/history';

export default function SettingsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  const loadHistory = useCallback(async () => {
    setHistory(await getHistory());
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadHistory();
    }, [loadHistory]),
  );

  const handleClear = () => {
    Alert.alert('Clear History', 'Delete all print history?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear',
        style: 'destructive',
        onPress: async () => {
          await clearHistory();
          setHistory([]);
        },
      },
    ]);
  };

  const topPad = Platform.OS === 'web' ? 67 : insets.top;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View
        style={[
          styles.header,
          { paddingTop: topPad + 14, backgroundColor: colors.background },
        ]}
      >
        <Text
          style={[
            styles.title,
            { color: colors.foreground, fontFamily: 'Inter_700Bold' },
          ]}
        >
          Settings
        </Text>
      </View>

      {/* Printer Info Card */}
      <View
        style={[
          styles.infoCard,
          { backgroundColor: colors.card, borderColor: colors.border },
        ]}
      >
        <View style={styles.infoRow}>
          <View
            style={[styles.iconBox, { backgroundColor: colors.accent }]}
          >
            <Feather name="bluetooth" size={18} color={colors.primary} />
          </View>
          <View style={styles.infoText}>
            <Text
              style={[
                styles.infoTitle,
                { color: colors.foreground, fontFamily: 'Inter_600SemiBold' },
              ]}
            >
              Core Tech N12
            </Text>
            <Text
              style={[
                styles.infoSub,
                {
                  color: colors.mutedForeground,
                  fontFamily: 'Inter_400Regular',
                },
              ]}
            >
              Pair via Android Bluetooth settings
            </Text>
          </View>
          <View style={[styles.chip, { backgroundColor: colors.muted }]}>
            <Text
              style={[
                styles.chipText,
                { color: colors.mutedForeground, fontFamily: 'Inter_500Medium' },
              ]}
            >
              12 mm labels
            </Text>
          </View>
        </View>

        <View style={[styles.divider, { backgroundColor: colors.border }]} />

        <Text
          style={[
            styles.btBody,
            { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' },
          ]}
        >
          Pair your N12 printer with your phone in Android Bluetooth settings, then tap
          Print Label on any card. Printing to Bluetooth requires building as an APK — see
          the README for step-by-step build instructions.
        </Text>

        <View
          style={[
            styles.noteBadge,
            { backgroundColor: colors.accent, borderColor: colors.border },
          ]}
        >
          <Feather name="info" size={12} color={colors.primary} />
          <Text
            style={[
              styles.noteText,
              { color: colors.primary, fontFamily: 'Inter_500Medium' },
            ]}
          >
            Labels are formatted for 12 mm × 40 mm N12 tape
          </Text>
        </View>
      </View>

      {/* Print History header */}
      <View style={styles.historyHeader}>
        <Text
          style={[
            styles.sectionTitle,
            { color: colors.foreground, fontFamily: 'Inter_600SemiBold' },
          ]}
        >
          Print History
        </Text>
        {history.length > 0 && (
          <TouchableOpacity onPress={handleClear} hitSlop={8}>
            <Text
              style={[
                styles.clearText,
                { color: colors.destructive, fontFamily: 'Inter_500Medium' },
              ]}
            >
              Clear all
            </Text>
          </TouchableOpacity>
        )}
      </View>

      <FlatList
        data={history}
        keyExtractor={(item) => item.id}
        contentContainerStyle={[
          styles.list,
          {
            paddingBottom:
              Platform.OS === 'web' ? 34 + 32 : insets.bottom + 32,
          },
        ]}
        renderItem={({ item }) => (
          <View
            style={[
              styles.historyItem,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}
          >
            <View style={styles.historyInfo}>
              <Text
                style={[
                  styles.historyName,
                  { color: colors.foreground, fontFamily: 'Inter_600SemiBold' },
                ]}
                numberOfLines={1}
              >
                {item.cardName}
              </Text>
              <Text
                style={[
                  styles.historySeries,
                  {
                    color: colors.mutedForeground,
                    fontFamily: 'Inter_400Regular',
                  },
                ]}
                numberOfLines={1}
              >
                {item.series}
              </Text>
            </View>
            <View style={styles.historyRight}>
              <Text
                style={[
                  styles.historyValue,
                  { color: colors.primary, fontFamily: 'Inter_700Bold' },
                ]}
              >
                {item.value}
              </Text>
              <Text
                style={[
                  styles.historyDate,
                  {
                    color: colors.mutedForeground,
                    fontFamily: 'Inter_400Regular',
                  },
                ]}
              >
                {new Date(item.printedAt).toLocaleDateString()}
              </Text>
            </View>
          </View>
        )}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Feather
              name="printer"
              size={44}
              color={colors.mutedForeground}
              style={{ opacity: 0.35 }}
            />
            <Text
              style={[
                styles.emptyText,
                { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' },
              ]}
            >
              No prints yet
            </Text>
          </View>
        }
        scrollEnabled={history.length > 0}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingHorizontal: 16, paddingBottom: 12 },
  title: { fontSize: 28 },
  infoCard: {
    marginHorizontal: 16,
    marginBottom: 20,
    padding: 16,
    borderRadius: 14,
    borderWidth: 1,
    gap: 12,
  },
  infoRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  iconBox: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  infoText: { flex: 1 },
  infoTitle: { fontSize: 15 },
  infoSub: { fontSize: 12, marginTop: 1 },
  chip: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  chipText: { fontSize: 11 },
  divider: { height: 1 },
  btBody: { fontSize: 13, lineHeight: 20 },
  noteBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
    alignSelf: 'flex-start',
  },
  noteText: { fontSize: 12 },
  historyHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    marginBottom: 10,
  },
  sectionTitle: { fontSize: 16 },
  clearText: { fontSize: 14 },
  list: { paddingHorizontal: 16 },
  historyItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    borderRadius: 10,
    borderWidth: 1,
    marginBottom: 8,
  },
  historyInfo: { flex: 1, marginRight: 12 },
  historyName: { fontSize: 14, marginBottom: 2 },
  historySeries: { fontSize: 12 },
  historyRight: { alignItems: 'flex-end', gap: 3 },
  historyValue: { fontSize: 14 },
  historyDate: { fontSize: 11 },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 52,
    gap: 10,
  },
  emptyText: { fontSize: 14 },
});

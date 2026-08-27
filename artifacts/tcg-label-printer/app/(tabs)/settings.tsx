import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import {
  addHistoryEntry,
  clearHistory,
  getHistory,
  updateHistoryStatus,
  type HistoryEntry,
} from '@/services/history';
import {
  extractPrinterErrorMessage,
  type LabelData,
  sendToPrinter,
} from '@/services/printer';
import { PrintLabel } from '@/components/PrintLabel';
import { PrinterSetupCard } from '@/components/PrinterSetupCard';
import { formatPrice } from '@/services/pricecharting';
import {
  activeCollectionValue,
  entryCurrentPriceCents,
  entryPriceMovementCents,
  getMinimumPriceAlertCents,
  isEntryPriceStale,
  refreshHistoryPrices,
  setMinimumPriceAlertCents,
} from '@/services/priceWatch';
import {
  DEFAULT_SQUARE_EXPORT_OPTIONS,
  exportSquareInventoryCsv,
  getSquareExportPreview,
  type DuplicateHandling,
  type SquareExportOptions,
} from '@/services/squareExport';

const CONDITION_FILTERS = ['All', 'Loose', 'CIB', 'New', 'Graded', 'Custom'] as const;
const DATE_FILTERS = ['All time', 'Today', '7 days', '30 days'] as const;

function isActiveInventoryEntry(entry: HistoryEntry): boolean {
  return entry.inventoryTracked !== false && (entry.status ?? 'active') === 'active';
}

function HistoryPreview({ entry }: { entry: HistoryEntry }) {
  const label: LabelData = {
    cardName: entry.cardName,
    series: entry.series,
    value: entry.value,
    cardId: entry.cardId,
    condition: entry.condition,
    generatedAt: entry.generatedAt ?? new Date(entry.printedAt).toISOString(),
    preset: entry.preset,
    customFields: entry.customFields,
    sku: entry.sku,
    quantity: entry.quantity,
    priceCents: entry.priceCents,
    stale: entry.stale,
  };
  return <PrintLabel label={label} />;
}

export default function SettingsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyQuery, setHistoryQuery] = useState('');
  const [setFilter, setSetFilter] = useState('');
  const [dateFilter, setDateFilter] = useState<(typeof DATE_FILTERS)[number]>('All time');
  const [conditionFilter, setConditionFilter] =
    useState<(typeof CONDITION_FILTERS)[number]>('All');
  const [selectedEntry, setSelectedEntry] = useState<HistoryEntry | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [exportableSelectionIds, setExportableSelectionIds] = useState<string[]>([]);
  const [selectMode, setSelectMode] = useState(false);
  const [exportVisible, setExportVisible] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [reprinting, setReprinting] = useState(false);
  const [refreshingPrices, setRefreshingPrices] = useState(false);
  const [minimumPrice, setMinimumPrice] = useState('');
  const [sortByMovement, setSortByMovement] = useState(false);
  const [exportOptions, setExportOptions] =
    useState<SquareExportOptions>(DEFAULT_SQUARE_EXPORT_OPTIONS);

  const loadHistory = useCallback(async () => {
    const [entries, threshold] = await Promise.all([getHistory(), getMinimumPriceAlertCents()]);
    setHistory(entries);
    setMinimumPrice(threshold ? (threshold / 100).toFixed(2) : '');
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadHistory();
    }, [loadHistory]),
  );

  const visibleHistory = useMemo(() => {
    const needle = historyQuery.trim().toLowerCase();
    const setNeedle = setFilter.trim().toLowerCase();
    const now = Date.now();
    const minimumDate =
      dateFilter === 'Today'
        ? new Date(new Date().setHours(0, 0, 0, 0)).getTime()
        : dateFilter === '7 days'
          ? now - 7 * 24 * 60 * 60 * 1000
          : dateFilter === '30 days'
            ? now - 30 * 24 * 60 * 60 * 1000
            : 0;
    const filtered = history.filter((entry) => {
      const matchesCondition =
        conditionFilter === 'All' || (entry.condition ?? 'Price') === conditionFilter;
      const matchesSet = !setNeedle || entry.series.toLowerCase().includes(setNeedle);
      const matchesDate = !minimumDate || entry.printedAt >= minimumDate;
      const matchesSearch =
        !needle ||
        [entry.cardName, entry.series, entry.cardId, entry.sku, entry.value, entry.condition]
          .filter(Boolean)
          .some((field) => String(field).toLowerCase().includes(needle));
      return matchesCondition && matchesSearch && matchesSet && matchesDate;
    });
    return sortByMovement
      ? [...filtered].sort((left, right) => Math.abs(entryPriceMovementCents(right)) - Math.abs(entryPriceMovementCents(left)))
      : filtered;
  }, [conditionFilter, dateFilter, history, historyQuery, setFilter, sortByMovement]);

  const selectedEntries = useMemo(
    () => history.filter((entry) => selectedIds.includes(entry.id)),
    [history, selectedIds],
  );
  const selectedInventoryEntries = useMemo(
    () =>
      selectedEntries.filter(
        (entry) => exportableSelectionIds.includes(entry.id) && isActiveInventoryEntry(entry),
      ),
    [exportableSelectionIds, selectedEntries],
  );

  const exportPreview = useMemo(
    () => getSquareExportPreview(selectedInventoryEntries, exportOptions),
    [exportOptions, selectedInventoryEntries],
  );

  useEffect(() => {
    if (!selectedInventoryEntries.length) {
      setExportVisible(false);
    }
  }, [selectedInventoryEntries.length]);

  const handleClear = () => {
    Alert.alert('Clear History', 'Delete all print history?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear',
        style: 'destructive',
        onPress: async () => {
          await clearHistory();
          setHistory([]);
          setSelectedEntry(null);
        },
      },
    ]);
  };

  const handleExport = async () => {
    if (!selectedInventoryEntries.length || exporting) return;
    setExporting(true);
    try {
      await exportSquareInventoryCsv(selectedInventoryEntries, exportOptions);
      setExportVisible(false);
      Alert.alert(
        'Square CSV Ready',
        exportOptions.locationName.trim()
          ? `Your CSV includes quantity for ${exportOptions.locationName.trim()}. Import it from Square Item Library and confirm the field mapping.`
          : 'Your inventory file is ready. In Square Item Library, map New Quantity to your store location.',
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unable to create the CSV file.';
      Alert.alert('Export Failed', message);
    } finally {
      setExporting(false);
    }
  };

  const handleOpenExport = async () => {
    if (exporting) return;
    const currentHistory = await getHistory();
    const currentSelection = currentHistory.filter(
      (entry) =>
        selectedIds.includes(entry.id) &&
        exportableSelectionIds.includes(entry.id) &&
        isActiveInventoryEntry(entry),
    );
    setHistory(currentHistory);
    if (!currentSelection.length) {
      setExportVisible(false);
      Alert.alert('Select labels', 'Choose one or more active inventory labels to export to Square.');
      setSelectMode(true);
      return;
    }
    setExportVisible(true);
  };

  const handleReprint = async () => {
    if (!selectedEntry || reprinting) return;
    const label: LabelData = {
      cardName: selectedEntry.cardName,
      series: selectedEntry.series,
      value: selectedEntry.value,
      cardId: selectedEntry.cardId,
      condition: selectedEntry.condition,
      generatedAt: selectedEntry.generatedAt ?? new Date(selectedEntry.printedAt).toISOString(),
      preset: selectedEntry.preset,
      customFields: selectedEntry.customFields,
      sku: selectedEntry.sku,
      quantity: selectedEntry.quantity,
      priceCents: selectedEntry.priceCents,
      stale: selectedEntry.stale,
    };

    setReprinting(true);
    try {
      await addHistoryEntry({ ...label, isReprint: true, inventoryTracked: false });
      const delivery = await sendToPrinter('', label);
      Alert.alert(
        delivery.statusReceived ? 'D11 status received' : 'Label queued for D11',
        delivery.statusReceived
          ? 'The D11 reported print status. Check the label as it feeds.'
          : 'The label’s BLE packets were queued. This is not a printer acknowledgement, so check the label as it feeds.',
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      Alert.alert(
        message.includes('EXPO_GO_ONLY') ? 'Saved to History' : 'Print Error',
        message.includes('EXPO_GO_ONLY')
          ? 'The reprint was saved to history. Build the Android APK to print through the NIIMBOT D11.'
          : extractPrinterErrorMessage(error),
      );
    } finally {
      setReprinting(false);
      await loadHistory();
    }
  };

  const toggleSelection = (id: string) => {
    const entry = history.find((historyEntry) => historyEntry.id === id);
    setSelectedIds((current) => {
      const isRemoving = current.includes(id);
      setExportableSelectionIds((exportableCurrent) =>
        isRemoving
          ? exportableCurrent.filter((savedId) => savedId !== id)
          : isActiveInventoryEntry(entry ?? ({} as HistoryEntry))
            ? [...exportableCurrent, id]
            : exportableCurrent,
      );
      return isRemoving ? current.filter((savedId) => savedId !== id) : [...current, id];
    });
  };

  const handleStatusChange = async (status: HistoryEntry['status'], ids = selectedIds) => {
    if (!ids.length) return;
    const next = await updateHistoryStatus(ids, status);
    setHistory(next);
    setSelectedIds([]);
    setExportableSelectionIds([]);
    setSelectedEntry(null);
  };

  const handleRefreshPrices = async () => {
    if (refreshingPrices) return;
    setRefreshingPrices(true);
    try {
      const summary = await refreshHistoryPrices(history);
      setHistory(summary.entries);
      Alert.alert(
        'Price refresh complete',
        `${summary.refreshedCards} card${summary.refreshedCards === 1 ? '' : 's'} refreshed · ${summary.changedEntries} label${summary.changedEntries === 1 ? '' : 's'} changed${summary.failedCards ? ` · ${summary.failedCards} could not refresh` : ''}`,
      );
    } catch (error: unknown) {
      Alert.alert('Refresh failed', error instanceof Error ? error.message : 'Could not refresh saved prices.');
    } finally {
      setRefreshingPrices(false);
    }
  };

  const handleMinimumPriceChange = (value: string) => {
    setMinimumPrice(value);
    const dollars = Number.parseFloat(value.replace(/[^0-9.]/g, ''));
    setMinimumPriceAlertCents(Number.isFinite(dollars) ? Math.round(dollars * 100) : 0).catch(() => undefined);
  };

  const activeValue = activeCollectionValue(history);
  const alertThresholdCents = Math.round((Number.parseFloat(minimumPrice) || 0) * 100);
  const alertCount = history.filter(
    (entry) =>
      (entry.status ?? 'active') === 'active' &&
      entry.inventoryTracked !== false &&
      alertThresholdCents > 0 &&
      entryCurrentPriceCents(entry) <= alertThresholdCents,
  ).length;

  const topPad = Platform.OS === 'web' ? 67 : insets.top;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View
        style={[
          styles.header,
          { paddingTop: topPad + 14, backgroundColor: colors.background },
        ]}
      >
        <Text style={[styles.title, { color: colors.foreground, fontFamily: 'Inter_700Bold' }]}>
          Settings
        </Text>
      </View>

      <PrinterSetupCard />

      <View style={[styles.priceCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={styles.priceHeader}>
          <View>
            <Text style={[styles.sectionTitle, { color: colors.foreground, fontFamily: 'Inter_600SemiBold' }]}>
              Price Refresh
            </Text>
            <Text style={[styles.priceSub, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
              Active collection value · {formatPrice(activeValue)}
            </Text>
          </View>
          <TouchableOpacity
            onPress={handleRefreshPrices}
            disabled={
              refreshingPrices ||
              !history.some(
                (entry) =>
                  entry.cardId &&
                  (entry.status ?? 'active') === 'active' &&
                  entry.inventoryTracked !== false &&
                  entry.condition?.toLowerCase() !== 'custom',
              )
            }
            style={[styles.refreshButton, { backgroundColor: refreshingPrices ? colors.muted : colors.primary }]}
            testID="refresh-prices"
          >
            {refreshingPrices ? (
              <ActivityIndicator size="small" color={colors.primaryForeground} />
            ) : (
              <Feather name="refresh-cw" size={15} color={colors.primaryForeground} />
            )}
            <Text style={[styles.refreshText, { color: colors.primaryForeground, fontFamily: 'Inter_600SemiBold' }]}>
              Refresh
            </Text>
          </TouchableOpacity>
        </View>
        <View style={styles.minimumRow}>
          <View style={styles.minimumCopy}>
            <Text style={[styles.minimumLabel, { color: colors.mutedForeground, fontFamily: 'Inter_500Medium' }]}>
              MINIMUM PRICE FLAG
            </Text>
            <Text style={[styles.minimumHelp, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
              {alertCount ? `${alertCount} active label${alertCount === 1 ? '' : 's'} below your minimum.` : 'Flag active labels priced below this amount.'}
            </Text>
          </View>
          <View style={[styles.minimumInput, { backgroundColor: colors.background, borderColor: colors.border }]}>
            <Text style={[styles.currencyMark, { color: colors.mutedForeground }]}>$</Text>
            <TextInput
              value={minimumPrice}
              onChangeText={handleMinimumPriceChange}
              keyboardType="decimal-pad"
              placeholder="0.00"
              placeholderTextColor={colors.mutedForeground}
              style={[styles.minimumInputText, { color: colors.foreground, fontFamily: 'Inter_500Medium' }]}
              testID="minimum-price-alert"
            />
          </View>
        </View>
      </View>

      <View style={styles.historyHeader}>
        <View>
          <Text style={[styles.sectionTitle, { color: colors.foreground, fontFamily: 'Inter_600SemiBold' }]}>
            Print History
          </Text>
          {!!history.length && (
            <Text style={[styles.historyCount, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
              {history.length} saved label{history.length === 1 ? '' : 's'}
            </Text>
          )}
        </View>
        {history.length > 0 && (
          <View style={styles.historyActions}>
            <TouchableOpacity
              style={[styles.selectButton, { borderColor: selectMode ? colors.primary : colors.border, backgroundColor: selectMode ? colors.accent : colors.card }]}
              onPress={() => {
                setSelectMode((current) => !current);
                if (selectMode) {
                  setSelectedIds([]);
                  setExportableSelectionIds([]);
                }
              }}
            >
              <Text style={[styles.selectText, { color: colors.primary, fontFamily: 'Inter_600SemiBold' }]}>
                {selectMode ? 'Done' : 'Select'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.exportButton, { borderColor: selectedInventoryEntries.length ? colors.primary : colors.border }]}
              onPress={handleOpenExport}
              disabled={exporting}
              testID="export-square-csv"
            >
              <Feather name="upload-cloud" size={14} color={colors.primary} />
              <Text style={[styles.exportText, { color: colors.primary, fontFamily: 'Inter_600SemiBold' }]}>
                Square
              </Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={handleClear} hitSlop={8} disabled={exporting}>
              <Text style={[styles.clearText, { color: colors.destructive, fontFamily: 'Inter_500Medium' }]}>
                Clear all
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      {!!history.length && (
        <View style={styles.filters}>
          <View style={[styles.searchBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Feather name="search" size={16} color={colors.mutedForeground} />
            <TextInput
              value={historyQuery}
              onChangeText={setHistoryQuery}
              placeholder="Search card, set, SKU, price…"
              placeholderTextColor={colors.mutedForeground}
              style={[styles.searchInput, { color: colors.foreground, fontFamily: 'Inter_400Regular' }]}
              testID="history-search"
            />
            {!!historyQuery && (
              <TouchableOpacity onPress={() => setHistoryQuery('')} hitSlop={8}>
                <Feather name="x" size={15} color={colors.mutedForeground} />
              </TouchableOpacity>
            )}
          </View>
          <View style={[styles.searchBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Feather name="layers" size={16} color={colors.mutedForeground} />
            <TextInput
              value={setFilter}
              onChangeText={setSetFilter}
              placeholder="Filter by set or series"
              placeholderTextColor={colors.mutedForeground}
              style={[styles.searchInput, { color: colors.foreground, fontFamily: 'Inter_400Regular' }]}
              testID="history-set-filter"
            />
            {!!setFilter && (
              <TouchableOpacity onPress={() => setSetFilter('')} hitSlop={8}>
                <Feather name="x" size={15} color={colors.mutedForeground} />
              </TouchableOpacity>
            )}
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterRow}>
            {CONDITION_FILTERS.map((filter) => (
              <TouchableOpacity
                key={filter}
                onPress={() => setConditionFilter(filter)}
                style={[
                  styles.filterChip,
                  {
                    backgroundColor: conditionFilter === filter ? colors.primary : colors.accent,
                    borderColor: conditionFilter === filter ? colors.primary : colors.border,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.filterText,
                    {
                      color: conditionFilter === filter ? colors.primaryForeground : colors.foreground,
                      fontFamily: 'Inter_500Medium',
                    },
                  ]}
                >
                  {filter}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterRow}>
            {DATE_FILTERS.map((filter) => (
              <TouchableOpacity
                key={filter}
                onPress={() => setDateFilter(filter)}
                style={[
                  styles.filterChip,
                  {
                    backgroundColor: dateFilter === filter ? colors.primary : colors.accent,
                    borderColor: dateFilter === filter ? colors.primary : colors.border,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.filterText,
                    {
                      color: dateFilter === filter ? colors.primaryForeground : colors.foreground,
                      fontFamily: 'Inter_500Medium',
                    },
                  ]}
                >
                  {filter}
                </Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity
              onPress={() => setSortByMovement((current) => !current)}
              style={[
                styles.filterChip,
                {
                  backgroundColor: sortByMovement ? colors.primary : colors.accent,
                  borderColor: sortByMovement ? colors.primary : colors.border,
                },
              ]}
            >
              <Feather name="trending-up" size={13} color={sortByMovement ? colors.primaryForeground : colors.primary} />
              <Text
                style={[
                  styles.filterText,
                  {
                    color: sortByMovement ? colors.primaryForeground : colors.foreground,
                    fontFamily: 'Inter_500Medium',
                  },
                ]}
              >
                Movement
              </Text>
            </TouchableOpacity>
          </ScrollView>
          {selectMode && (
            <View style={styles.selectionBar}>
              <Text style={[styles.selectionCount, { color: colors.mutedForeground, fontFamily: 'Inter_500Medium' }]}>
                {selectedEntries.length} selected
              </Text>
              <TouchableOpacity onPress={() => handleStatusChange('active')} disabled={!selectedEntries.length}>
                <Text style={[styles.selectionAction, { color: colors.primary, fontFamily: 'Inter_600SemiBold' }]}>Active</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => handleStatusChange('sold')} disabled={!selectedEntries.length}>
                <Text style={[styles.selectionAction, { color: colors.primary, fontFamily: 'Inter_600SemiBold' }]}>Sold</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => handleStatusChange('removed')} disabled={!selectedEntries.length}>
                <Text style={[styles.selectionAction, { color: colors.destructive, fontFamily: 'Inter_600SemiBold' }]}>Remove</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      )}

      <FlatList
        data={visibleHistory}
        keyExtractor={(item) => item.id}
        contentContainerStyle={[
          styles.list,
          { paddingBottom: Platform.OS === 'web' ? 34 + 32 : insets.bottom + 32 },
        ]}
        renderItem={({ item }) => (
          <TouchableOpacity
            onPress={() => (selectMode ? toggleSelection(item.id) : setSelectedEntry(item))}
            style={[styles.historyItem, { backgroundColor: colors.card, borderColor: colors.border }]}
          >
            {selectMode && (
              <View
                style={[
                  styles.selectionCircle,
                  {
                    backgroundColor: selectedIds.includes(item.id) ? colors.primary : colors.background,
                    borderColor: selectedIds.includes(item.id) ? colors.primary : colors.border,
                  },
                ]}
              >
                {selectedIds.includes(item.id) && <Feather name="check" size={13} color={colors.primaryForeground} />}
              </View>
            )}
            <View style={styles.historyInfo}>
              <Text
                style={[styles.historyName, { color: colors.foreground, fontFamily: 'Inter_600SemiBold' }]}
                numberOfLines={1}
              >
                {item.cardName}
              </Text>
              <Text
                style={[styles.historySeries, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}
                numberOfLines={1}
              >
                {item.series}
              </Text>
              <View style={[styles.conditionBadge, { backgroundColor: colors.accent }]}>
                <Text style={[styles.conditionBadgeText, { color: colors.primary, fontFamily: 'Inter_500Medium' }]}>
                  {item.condition ?? 'Price'}
                </Text>
              </View>
              {(item.status ?? 'active') !== 'active' && (
                <Text style={[styles.statusText, { color: colors.destructive, fontFamily: 'Inter_600SemiBold' }]}>
                  {(item.status ?? 'active').toUpperCase()}
                </Text>
              )}
              {item.isReprint && (
                <Text style={[styles.staleHistory, { color: colors.mutedForeground, fontFamily: 'Inter_500Medium' }]}>
                  REPRINT · NOT INVENTORY
                </Text>
              )}
              {isEntryPriceStale(item) && (item.status ?? 'active') === 'active' && (
                <Text style={[styles.staleHistory, { color: colors.mutedForeground, fontFamily: 'Inter_500Medium' }]}>
                  PRICE NEEDS REFRESH
                </Text>
              )}
            </View>
            <View style={styles.historyRight}>
              <Text style={[styles.historyValue, { color: colors.primary, fontFamily: 'Inter_700Bold' }]}>
                {formatPrice(entryCurrentPriceCents(item))}
              </Text>
              {entryPriceMovementCents(item) !== 0 && (
                <Text
                  style={[
                    styles.movementText,
                    {
                      color: entryPriceMovementCents(item) > 0 ? colors.primary : colors.destructive,
                      fontFamily: 'Inter_600SemiBold',
                    },
                  ]}
                >
                  {entryPriceMovementCents(item) > 0 ? '+' : ''}{formatPrice(entryPriceMovementCents(item))}
                </Text>
              )}
              <Text style={[styles.historyDate, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
                {new Date(item.printedAt).toLocaleDateString()}
              </Text>
              <Feather name="repeat" size={14} color={colors.mutedForeground} style={{ marginTop: 3 }} />
            </View>
          </TouchableOpacity>
        )}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Feather
              name={history.length ? 'search' : 'printer'}
              size={44}
              color={colors.mutedForeground}
              style={{ opacity: 0.35 }}
            />
            <Text style={[styles.emptyText, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
              {history.length ? 'No labels match those filters' : 'No prints yet'}
            </Text>
          </View>
        }
        scrollEnabled={history.length > 0}
      />

      <Modal
        visible={!!selectedEntry}
        transparent
        animationType="slide"
        onRequestClose={() => setSelectedEntry(null)}
      >
        <View style={styles.modalBackdrop}>
          <View style={[styles.sheet, { backgroundColor: colors.background, borderColor: colors.border }]}>
            <View style={styles.sheetHeader}>
              <View>
                <Text style={[styles.sheetTitle, { color: colors.foreground, fontFamily: 'Inter_700Bold' }]}>
                  Label preview
                </Text>
                <Text style={[styles.sheetSubtitle, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
                  Reprint this saved label without searching again.
                </Text>
              </View>
              <TouchableOpacity onPress={() => setSelectedEntry(null)} hitSlop={8}>
                <Feather name="x" size={20} color={colors.mutedForeground} />
              </TouchableOpacity>
            </View>
            {selectedEntry && <HistoryPreview entry={selectedEntry} />}
            {selectedEntry && (
              <View style={styles.statusActions}>
                {(['active', 'sold', 'removed'] as const).map((status) => {
                  const selected = (selectedEntry.status ?? 'active') === status;
                  return (
                    <TouchableOpacity
                      key={status}
                      onPress={() => handleStatusChange(status, [selectedEntry.id])}
                      style={[
                        styles.statusButton,
                        {
                          backgroundColor: selected ? colors.primary : colors.card,
                          borderColor: selected ? colors.primary : colors.border,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.statusButtonText,
                          {
                            color: selected ? colors.primaryForeground : colors.foreground,
                            fontFamily: 'Inter_600SemiBold',
                          },
                        ]}
                      >
                        {status === 'removed' ? 'Removed' : status[0].toUpperCase() + status.slice(1)}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}
            <TouchableOpacity
              onPress={handleReprint}
              disabled={reprinting}
              style={[styles.reprintButton, { backgroundColor: reprinting ? colors.muted : colors.primary }]}
              testID="reprint-history-entry"
            >
              {reprinting ? (
                <ActivityIndicator color={colors.primaryForeground} />
              ) : (
                <>
                  <Feather name="printer" size={19} color={colors.primaryForeground} />
                  <Text style={[styles.reprintButtonText, { color: colors.primaryForeground, fontFamily: 'Inter_600SemiBold' }]}>
                    Reprint label
                  </Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal
        visible={exportVisible && selectedInventoryEntries.length > 0}
        transparent
        animationType="slide"
        onRequestClose={() => !exporting && setExportVisible(false)}
      >
        <View style={styles.modalBackdrop}>
          <ScrollView
            contentContainerStyle={[styles.exportSheet, { backgroundColor: colors.background, borderColor: colors.border }]}
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.sheetHeader}>
              <View>
                <Text style={[styles.sheetTitle, { color: colors.foreground, fontFamily: 'Inter_700Bold' }]}>
                  Square import assistant
                </Text>
                <Text style={[styles.sheetSubtitle, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
                  Review the item details before downloading your CSV.
                </Text>
              </View>
              <TouchableOpacity onPress={() => !exporting && setExportVisible(false)} hitSlop={8}>
                <Feather name="x" size={20} color={colors.mutedForeground} />
              </TouchableOpacity>
            </View>

            <View style={[styles.previewCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.previewNumber, { color: colors.primary, fontFamily: 'Inter_700Bold' }]}>
                {exportPreview.outputRows}
              </Text>
              <View>
                <Text style={[styles.previewTitle, { color: colors.foreground, fontFamily: 'Inter_600SemiBold' }]}>
                  Square item row{exportPreview.outputRows === 1 ? '' : 's'}
                </Text>
                <Text style={[styles.previewBody, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
                  {exportPreview.mergedEntries
                    ? `${exportPreview.mergedEntries} matching label${exportPreview.mergedEntries === 1 ? '' : 's'} combined.`
                    : `${exportPreview.sourceEntries} saved label${exportPreview.sourceEntries === 1 ? '' : 's'} included.`}
                </Text>
              </View>
            </View>

            <Text style={[styles.fieldLabel, { color: colors.mutedForeground, fontFamily: 'Inter_500Medium' }]}>
              CATEGORY
            </Text>
            <TextInput
              value={exportOptions.category}
              onChangeText={(category) => setExportOptions((current) => ({ ...current, category }))}
              style={[styles.fieldInput, { color: colors.foreground, backgroundColor: colors.card, borderColor: colors.border, fontFamily: 'Inter_400Regular' }]}
              placeholder="Trading Cards"
              placeholderTextColor={colors.mutedForeground}
            />
            <Text style={[styles.fieldLabel, { color: colors.mutedForeground, fontFamily: 'Inter_500Medium' }]}>
              REPORTING CATEGORY
            </Text>
            <TextInput
              value={exportOptions.reportingCategory}
              onChangeText={(reportingCategory) => setExportOptions((current) => ({ ...current, reportingCategory }))}
              style={[styles.fieldInput, { color: colors.foreground, backgroundColor: colors.card, borderColor: colors.border, fontFamily: 'Inter_400Regular' }]}
              placeholder="Trading Cards"
              placeholderTextColor={colors.mutedForeground}
            />
            <Text style={[styles.fieldLabel, { color: colors.mutedForeground, fontFamily: 'Inter_500Medium' }]}>
              SQUARE LOCATION (OPTIONAL)
            </Text>
            <TextInput
              value={exportOptions.locationName}
              onChangeText={(locationName) => setExportOptions((current) => ({ ...current, locationName }))}
              style={[styles.fieldInput, { color: colors.foreground, backgroundColor: colors.card, borderColor: colors.border, fontFamily: 'Inter_400Regular' }]}
              placeholder="Main store"
              placeholderTextColor={colors.mutedForeground}
            />
            <Text style={[styles.helperText, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
              Adds a location-specific New Quantity column when provided.
            </Text>

            <Text style={[styles.fieldLabel, { color: colors.mutedForeground, fontFamily: 'Inter_500Medium' }]}>
              QUANTITY PER LABEL
            </Text>
            <TextInput
              value={String(exportOptions.quantityPerEntry)}
              onChangeText={(value) => {
                const quantityPerEntry = Math.max(1, Number.parseInt(value, 10) || 1);
                setExportOptions((current) => ({ ...current, quantityPerEntry }));
              }}
              keyboardType="number-pad"
              style={[styles.fieldInput, { color: colors.foreground, backgroundColor: colors.card, borderColor: colors.border, fontFamily: 'Inter_400Regular' }]}
            />

            <Text style={[styles.fieldLabel, { color: colors.mutedForeground, fontFamily: 'Inter_500Medium' }]}>
              DUPLICATE LABELS
            </Text>
            <View style={styles.duplicateOptions}>
              {([
                ['merge', 'Combine matching cards'],
                ['separate', 'Keep each label separate'],
              ] as const).map(([value, label]) => (
                <TouchableOpacity
                  key={value}
                  onPress={() =>
                    setExportOptions((current) => ({
                      ...current,
                      duplicateHandling: value as DuplicateHandling,
                    }))
                  }
                  style={[
                    styles.duplicateOption,
                    {
                      backgroundColor: exportOptions.duplicateHandling === value ? colors.primary : colors.card,
                      borderColor: exportOptions.duplicateHandling === value ? colors.primary : colors.border,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.duplicateOptionText,
                      {
                        color: exportOptions.duplicateHandling === value ? colors.primaryForeground : colors.foreground,
                        fontFamily: 'Inter_500Medium',
                      },
                    ]}
                  >
                    {label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <View style={[styles.importNote, { backgroundColor: colors.accent, borderColor: colors.border }]}>
              <Feather name="info" size={15} color={colors.primary} />
              <Text style={[styles.importNoteText, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
                In Square Item Library, review the column mapping before confirming the import.
              </Text>
            </View>

            <TouchableOpacity
              onPress={handleExport}
              disabled={exporting}
              style={[styles.reprintButton, { backgroundColor: exporting ? colors.muted : colors.primary }]}
            >
              {exporting ? (
                <ActivityIndicator color={colors.primaryForeground} />
              ) : (
                <>
                  <Feather name="download" size={19} color={colors.primaryForeground} />
                  <Text style={[styles.reprintButtonText, { color: colors.primaryForeground, fontFamily: 'Inter_600SemiBold' }]}>
                    Download Square CSV
                  </Text>
                </>
              )}
            </TouchableOpacity>
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingHorizontal: 16, paddingBottom: 12 },
  title: { fontSize: 28 },
  infoCard: { marginHorizontal: 16, marginBottom: 18, padding: 16, borderRadius: 14, borderWidth: 1, gap: 12 },
  infoRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  iconBox: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  infoText: { flex: 1 },
  infoTitle: { fontSize: 15 },
  infoSub: { fontSize: 12, marginTop: 1 },
  chip: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 },
  chipText: { fontSize: 11 },
  divider: { height: 1 },
  btBody: { fontSize: 13, lineHeight: 20 },
  priceCard: { marginHorizontal: 16, marginBottom: 18, padding: 14, borderRadius: 14, borderWidth: 1, gap: 13 },
  priceHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10 },
  priceSub: { fontSize: 12, marginTop: 3 },
  refreshButton: { height: 36, borderRadius: 9, paddingHorizontal: 11, flexDirection: 'row', alignItems: 'center', gap: 6 },
  refreshText: { fontSize: 12 },
  minimumRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  minimumCopy: { flex: 1 },
  minimumLabel: { fontSize: 10, letterSpacing: 0.7 },
  minimumHelp: { fontSize: 11, lineHeight: 15, marginTop: 3 },
  minimumInput: { width: 78, height: 40, borderWidth: 1, borderRadius: 9, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8 },
  currencyMark: { fontSize: 14 },
  minimumInputText: { flex: 1, height: 40, fontSize: 14, paddingLeft: 2 },
  historyHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, marginBottom: 10 },
  sectionTitle: { fontSize: 16 },
  historyCount: { fontSize: 12, marginTop: 2 },
  historyActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  selectButton: { borderWidth: 1, borderRadius: 7, paddingHorizontal: 8, paddingVertical: 5 },
  selectText: { fontSize: 12 },
  exportButton: { flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1, borderRadius: 7, paddingHorizontal: 8, paddingVertical: 5 },
  exportText: { fontSize: 12 },
  clearText: { fontSize: 14 },
  filters: { gap: 9, marginBottom: 10 },
  searchBox: { flexDirection: 'row', alignItems: 'center', height: 43, borderWidth: 1, borderRadius: 10, marginHorizontal: 16, paddingHorizontal: 11, gap: 8 },
  searchInput: { flex: 1, height: 43, fontSize: 14 },
  filterRow: { paddingHorizontal: 16, gap: 7 },
  filterChip: { borderWidth: 1, borderRadius: 16, paddingHorizontal: 11, paddingVertical: 6, flexDirection: 'row', alignItems: 'center', gap: 4 },
  filterText: { fontSize: 12 },
  selectionBar: { marginHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 14 },
  selectionCount: { flex: 1, fontSize: 12 },
  selectionAction: { fontSize: 12 },
  list: { paddingHorizontal: 16 },
  historyItem: { flexDirection: 'row', alignItems: 'center', padding: 14, borderRadius: 10, borderWidth: 1, marginBottom: 8, gap: 9 },
  selectionCircle: { width: 20, height: 20, borderRadius: 10, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  historyInfo: { flex: 1, marginRight: 12 },
  historyName: { fontSize: 14, marginBottom: 2 },
  historySeries: { fontSize: 12 },
  conditionBadge: { alignSelf: 'flex-start', marginTop: 7, borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2 },
  conditionBadgeText: { fontSize: 10 },
  statusText: { fontSize: 10, letterSpacing: 0.4, marginTop: 5 },
  staleHistory: { fontSize: 9, letterSpacing: 0.4, marginTop: 5 },
  historyRight: { alignItems: 'flex-end', gap: 3 },
  historyValue: { fontSize: 14 },
  movementText: { fontSize: 11 },
  historyDate: { fontSize: 11 },
  emptyState: { alignItems: 'center', justifyContent: 'center', paddingVertical: 52, gap: 10 },
  emptyText: { fontSize: 14 },
  modalBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0, 0, 0, 0.4)' },
  sheet: { borderTopLeftRadius: 22, borderTopRightRadius: 22, borderWidth: 1, padding: 18, gap: 16 },
  exportSheet: { borderTopLeftRadius: 22, borderTopRightRadius: 22, borderWidth: 1, padding: 18, gap: 10 },
  sheetHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 14 },
  sheetTitle: { fontSize: 19 },
  sheetSubtitle: { fontSize: 13, marginTop: 4, lineHeight: 19, maxWidth: 290 },
  statusActions: { flexDirection: 'row', gap: 7 },
  statusButton: { flex: 1, borderWidth: 1, borderRadius: 8, alignItems: 'center', paddingVertical: 8 },
  statusButtonText: { fontSize: 12 },
  reprintButton: { height: 54, borderRadius: 13, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9, marginTop: 2 },
  reprintButtonText: { fontSize: 16 },
  previewCard: { borderWidth: 1, borderRadius: 12, padding: 13, flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 4 },
  previewNumber: { fontSize: 28, minWidth: 32, textAlign: 'center' },
  previewTitle: { fontSize: 14 },
  previewBody: { fontSize: 12, marginTop: 3, lineHeight: 17 },
  fieldLabel: { fontSize: 10, letterSpacing: 0.7, marginTop: 6 },
  fieldInput: { height: 44, borderWidth: 1, borderRadius: 9, paddingHorizontal: 12, fontSize: 15 },
  helperText: { fontSize: 12, lineHeight: 17, marginTop: -3 },
  duplicateOptions: { gap: 8 },
  duplicateOption: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 11 },
  duplicateOptionText: { fontSize: 13 },
  importNote: { flexDirection: 'row', gap: 8, borderWidth: 1, borderRadius: 10, padding: 10, marginTop: 4 },
  importNoteText: { flex: 1, fontSize: 12, lineHeight: 17 },
});
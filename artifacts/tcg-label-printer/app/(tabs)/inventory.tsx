import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { Feather } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { getHistory } from '@/services/history';
import {
  applySuggestedQuantities,
  analyzeTcgplayerMatches,
  clearTcgplayerInventory,
  confirmTcgplayerMapping,
  getTcgplayerInventory,
  parseCsv,
  saveTcgplayerInventory,
  shareTcgplayerInventoryCsv,
  tcgplayerListingKey,
  validateTcgplayerCsv,
  type TcgplayerInventory,
  type TcgplayerMatchReview,
  type TcgplayerMatchSummary,
} from '@/services/tcgplayerCsv';

function integerValue(value: string): string {
  const parsed = Number.parseInt(value.replace(/[^0-9-]/g, ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? String(parsed) : '0';
}

function quantityFor(row: Record<string, string>, header: string): number {
  const value = Number.parseInt(row[header] ?? '0', 10);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export default function InventoryScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [inventory, setInventory] = useState<TcgplayerInventory | null>(null);
  const [summary, setSummary] = useState<TcgplayerMatchSummary | null>(null);
  const [reviewQueue, setReviewQueue] = useState<TcgplayerMatchReview[]>([]);
  const [confirmedRowIndexes, setConfirmedRowIndexes] = useState<Set<number>>(new Set());
  const [pickerReview, setPickerReview] = useState<TcgplayerMatchReview | null>(null);
  const [pickerSearch, setPickerSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const addQuantityHeader = 'Add to Quantity';
  const marketplacePriceHeader = 'TCG Marketplace Price';
  const totalQuantityHeader = 'Total Quantity';

  const loadInventory = useCallback(async () => {
    setLoading(true);
    const savedInventory = await getTcgplayerInventory();
    setInventory(savedInventory);
    if (savedInventory) {
      const analysis = analyzeTcgplayerMatches(savedInventory, await getHistory());
      setReviewQueue(analysis.reviewQueue);
      setConfirmedRowIndexes(new Set(analysis.matchedRowIndexes));
    } else {
      setReviewQueue([]);
      setConfirmedRowIndexes(new Set());
    }
    setLoading(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadInventory();
    }, [loadInventory]),
  );

  const rowCount = inventory?.rows.length ?? 0;
  const totalAddQuantity = useMemo(
    () =>
      inventory?.rows.reduce(
        (total, row) => total + quantityFor(row, addQuantityHeader),
        0,
      ) ?? 0,
    [inventory],
  );

  const updateRow = (index: number, value: string) => {
    if (!inventory || !confirmedRowIndexes.has(index)) return;
    const quantity = integerValue(value);
    const rows = inventory.rows.map((row, rowIndex) =>
      rowIndex === index ? { ...row, [addQuantityHeader]: quantity } : row,
    );
    const next = {
      ...inventory,
      rows,
      quantityOverrides: {
        ...inventory.quantityOverrides,
        [tcgplayerListingKey(inventory.rows[index], index)]: quantity,
      },
    };
    setInventory(next);
    saveTcgplayerInventory(next).catch(() => undefined);
  };

  const importCsv = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const pickerResult = await DocumentPicker.getDocumentAsync({
        type: ['text/csv', 'text/comma-separated-values', 'text/plain'],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (pickerResult.canceled || !pickerResult.assets[0]?.uri) return;

      const text = await new File(pickerResult.assets[0].uri).text();
      const parsed = parseCsv(text);
      const validationError = validateTcgplayerCsv(parsed.headers);
      if (validationError) {
        Alert.alert('Invalid TCGplayer file', validationError);
        return;
      }

      const imported: TcgplayerInventory = {
        headers: parsed.headers.includes(addQuantityHeader)
          ? parsed.headers
          : [...parsed.headers, addQuantityHeader],
        rows: parsed.rows.map((row) => ({
          ...row,
          [addQuantityHeader]: row[addQuantityHeader] ?? '0',
        })),
        importedAt: new Date().toISOString(),
      };
      const matchResult = applySuggestedQuantities(imported, await getHistory());
      await saveTcgplayerInventory(matchResult.inventory);
      setInventory(matchResult.inventory);
      setSummary(matchResult.summary);
      setReviewQueue(matchResult.reviewQueue);
      setConfirmedRowIndexes(new Set(matchResult.matchedRowIndexes));
      Alert.alert(
        'TCGplayer inventory imported',
        `${imported.rows.length} listing${imported.rows.length === 1 ? '' : 's'} are ready. ${
          matchResult.reviewQueue.length
        } label${matchResult.reviewQueue.length === 1 ? '' : 's'} need review before export.`,
      );
    } catch (error: unknown) {
      Alert.alert(
        'Import failed',
        error instanceof Error ? error.message : 'Could not read that CSV file.',
      );
    } finally {
      setBusy(false);
    }
  };

  const syncLabels = async () => {
    if (!inventory || busy) return;
    setBusy(true);
    try {
      const history = await getHistory();
      const result = applySuggestedQuantities(inventory, history);
      await saveTcgplayerInventory(result.inventory);
      setInventory(result.inventory);
      setSummary(result.summary);
      setReviewQueue(result.reviewQueue);
      setConfirmedRowIndexes(new Set(result.matchedRowIndexes));
      Alert.alert(
        'Suggestions applied',
        `${result.summary.matchedRows} listing${result.summary.matchedRows === 1 ? '' : 's'} matched active labels. ${
          result.reviewQueue.length
        } label${result.reviewQueue.length === 1 ? '' : 's'} still need review.`,
      );
    } finally {
      setBusy(false);
    }
  };

  const exportCsv = async () => {
    if (!inventory || busy) return;
    setBusy(true);
    try {
      const result = applySuggestedQuantities(inventory, await getHistory());
      await saveTcgplayerInventory(result.inventory);
      setInventory(result.inventory);
      setSummary(result.summary);
      setReviewQueue(result.reviewQueue);
      setConfirmedRowIndexes(new Set(result.matchedRowIndexes));
      if (result.reviewQueue.length > 0) {
        Alert.alert(
          'Review labels first',
          `${result.reviewQueue.length} active label${result.reviewQueue.length === 1 ? ' is' : 's are'} not linked to a confirmed TCGplayer listing. Choose a listing for each label before exporting.`,
        );
        return;
      }
      await shareTcgplayerInventoryCsv(result.inventory);
    } catch (error: unknown) {
      Alert.alert(
        'Export failed',
        error instanceof Error ? error.message : 'Could not create the TCGplayer CSV.',
      );
    } finally {
      setBusy(false);
    }
  };

  const confirmMapping = async (entryId: string, rowIndex: number) => {
    if (!inventory || busy) return;
    setBusy(true);
    try {
      const result = confirmTcgplayerMapping(inventory, await getHistory(), entryId, rowIndex);
      await saveTcgplayerInventory(result.inventory);
      setInventory(result.inventory);
      setSummary(result.summary);
      setReviewQueue(result.reviewQueue);
      setConfirmedRowIndexes(new Set(result.matchedRowIndexes));
      setPickerReview(null);
      setPickerSearch('');
    } catch (error: unknown) {
      Alert.alert(
        'Could not confirm listing',
        error instanceof Error ? error.message : 'That listing could not be selected.',
      );
    } finally {
      setBusy(false);
    }
  };

  const clearImported = () => {
    Alert.alert(
      'Remove imported inventory?',
      'This only removes the saved copy from PriceTag. It does not change anything on TCGplayer.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            await clearTcgplayerInventory();
            setInventory(null);
            setSummary(null);
            setReviewQueue([]);
            setConfirmedRowIndexes(new Set());
          },
        },
      ],
    );
  };

  const pickerCandidates = useMemo(() => {
    if (!pickerReview || !inventory) return [];
    const indexes = pickerReview.candidateRowIndexes.length
      ? pickerReview.candidateRowIndexes
      : inventory.rows.map((_, index) => index);
    const query = pickerSearch.trim().toLowerCase();
    if (!query) return indexes;
    return indexes.filter((index) =>
      [
        inventory.rows[index]['Product Name'],
        inventory.rows[index]['Set Name'],
        inventory.rows[index].Condition,
        inventory.rows[index]['TCGplayer ID'],
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(query),
    );
  }, [inventory, pickerReview, pickerSearch]);

  const topPad = Platform.OS === 'web' ? 67 : insets.top;

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: topPad + 14 }]}>
        <View>
          <Text style={[styles.title, { color: colors.foreground, fontFamily: 'Inter_700Bold' }]}>
            TCGplayer
          </Text>
          <Text style={[styles.subtitle, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
            Inventory CSV
          </Text>
        </View>
        {inventory && (
          <TouchableOpacity onPress={clearImported} hitSlop={8} accessibilityLabel="Remove imported inventory">
            <Feather name="trash-2" size={19} color={colors.destructive} />
          </TouchableOpacity>
        )}
      </View>

      {!inventory ? (
        <View style={styles.emptyWrap}>
          <View style={[styles.heroIcon, { backgroundColor: colors.accent }]}>
            <Feather name="upload-cloud" size={28} color={colors.primary} />
          </View>
          <Text style={[styles.emptyTitle, { color: colors.foreground, fontFamily: 'Inter_700Bold' }]}>
            Upload your TCGplayer export
          </Text>
          <Text style={[styles.emptyBody, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
            Export your live inventory from Seller Portal first. PriceTag keeps the TCGplayer IDs and listing details, then prepares quantity updates you can import back.
          </Text>
          <TouchableOpacity
            style={[styles.primaryButton, { backgroundColor: busy ? colors.muted : colors.primary }]}
            onPress={importCsv}
            disabled={busy}
            testID="import-tcgplayer-csv"
          >
            {busy ? <ActivityIndicator color={colors.primaryForeground} /> : <Feather name="upload" size={18} color={colors.primaryForeground} />}
            <Text style={[styles.primaryButtonText, { color: colors.primaryForeground, fontFamily: 'Inter_600SemiBold' }]}>
              Import CSV
            </Text>
          </TouchableOpacity>
          <Text style={[styles.note, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
            Seller Portal → Pricing → Export From Live
          </Text>
        </View>
      ) : (
        <FlatList
          data={inventory.rows}
          keyExtractor={(_, index) => `tcgplayer-row-${index}`}
          contentContainerStyle={[styles.list, { paddingBottom: Platform.OS === 'web' ? 34 : insets.bottom + 24 }]}
          ListHeaderComponent={
            <View style={styles.contentGap}>
              <View style={[styles.summaryCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <View style={styles.summaryTop}>
                  <View style={[styles.summaryIcon, { backgroundColor: colors.accent }]}>
                    <Feather name="check-circle" size={19} color={colors.primary} />
                  </View>
                  <View style={styles.summaryCopy}>
                    <Text style={[styles.summaryTitle, { color: colors.foreground, fontFamily: 'Inter_600SemiBold' }]}>
                      {rowCount} listing{rowCount === 1 ? '' : 's'} imported
                    </Text>
                    <Text style={[styles.summaryBody, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
                      {totalAddQuantity} total card{totalAddQuantity === 1 ? '' : 's'} queued to add
                    </Text>
                  </View>
                </View>
                <Text style={[styles.helpText, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
                  Match active labels below, review the Add to Quantity values, then export the complete CSV.
                </Text>
                <View style={styles.actionRow}>
                  <TouchableOpacity
                    style={[styles.secondaryButton, { borderColor: colors.primary }]}
                    onPress={syncLabels}
                    disabled={busy}
                    testID="match-tcgplayer-labels"
                  >
                    <Feather name="refresh-cw" size={15} color={colors.primary} />
                    <Text style={[styles.secondaryButtonText, { color: colors.primary, fontFamily: 'Inter_600SemiBold' }]}>
                      {busy ? 'Working…' : 'Match labels'}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.primaryButton, styles.actionButton, { backgroundColor: busy ? colors.muted : colors.primary }]}
                    onPress={exportCsv}
                    disabled={busy}
                    testID="export-tcgplayer-csv"
                  >
                    <Feather name="share" size={15} color={colors.primaryForeground} />
                    <Text style={[styles.primaryButtonText, { color: colors.primaryForeground, fontFamily: 'Inter_600SemiBold' }]}>
                      Export CSV
                    </Text>
                  </TouchableOpacity>
                </View>
                {summary && (
                  <Text style={[styles.matchSummary, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
                    {summary.matchedRows} listings matched · {summary.unmatchedRows} label{summary.unmatchedRows === 1 ? '' : 's'} need review · {summary.suggestedQuantity} suggested cards
                  </Text>
                )}
              </View>
              {reviewQueue.length > 0 && (
                <View style={styles.reviewSection}>
                  <View style={styles.reviewHeading}>
                    <Text style={[styles.sectionLabel, { color: colors.mutedForeground, fontFamily: 'Inter_600SemiBold' }]}>
                      REVIEW LABELS
                    </Text>
                    <Text style={[styles.reviewCount, { color: colors.destructive, fontFamily: 'Inter_600SemiBold' }]}>
                      {reviewQueue.length} open
                    </Text>
                  </View>
                  <Text style={[styles.helpText, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
                    Confirm the imported listing for each label. Quantity suggestions stay locked to confirmed listings.
                  </Text>
                  {reviewQueue.map((review) => (
                    <View key={review.entryId} style={[styles.reviewCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                      <View style={styles.rowTop}>
                        <View style={styles.rowCopy}>
                          <Text style={[styles.productName, { color: colors.foreground, fontFamily: 'Inter_600SemiBold' }]} numberOfLines={2}>
                            {review.cardName}
                          </Text>
                          <Text style={[styles.productMeta, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]} numberOfLines={1}>
                            {[review.series, review.condition, `${review.quantity} card${review.quantity === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}
                          </Text>
                        </View>
                        <Feather name={review.status === 'ambiguous' ? 'alert-circle' : 'help-circle'} size={18} color={colors.destructive} />
                      </View>
                      <Text style={[styles.reviewReason, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
                        {review.status === 'ambiguous'
                          ? `${review.candidateRowIndexes.length} imported listings share this card name.`
                          : 'No imported listing matched this card name.'}
                      </Text>
                      <TouchableOpacity
                        style={[styles.secondaryButton, { borderColor: colors.primary }]}
                        onPress={() => {
                          setPickerReview(review);
                          setPickerSearch('');
                        }}
                        disabled={busy}
                        testID={`review-tcgplayer-label-${review.entryId}`}
                      >
                        <Feather name="list" size={15} color={colors.primary} />
                        <Text style={[styles.secondaryButtonText, { color: colors.primary, fontFamily: 'Inter_600SemiBold' }]}>
                          {review.status === 'ambiguous' ? 'Choose the right listing' : 'Choose an imported listing'}
                        </Text>
                      </TouchableOpacity>
                    </View>
                  ))}
                </View>
              )}
              <Text style={[styles.sectionLabel, { color: colors.mutedForeground, fontFamily: 'Inter_600SemiBold' }]}>
                REVIEW QUANTITIES
              </Text>
            </View>
          }
          renderItem={({ item, index }) => (
            <View style={[styles.rowCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={styles.rowTop}>
                <View style={styles.rowCopy}>
                  <Text style={[styles.productName, { color: colors.foreground, fontFamily: 'Inter_600SemiBold' }]} numberOfLines={2}>
                    {item['Product Name'] || 'Unnamed listing'}
                  </Text>
                  <Text style={[styles.productMeta, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]} numberOfLines={1}>
                    {[item['Set Name'], item.Condition, item['TCGplayer ID']].filter(Boolean).join(' · ')}
                  </Text>
                </View>
                <Text style={[styles.price, { color: colors.primary, fontFamily: 'Inter_700Bold' }]}>
                  {item[marketplacePriceHeader] || '—'}
                </Text>
              </View>
              <View style={styles.quantityRow}>
                <View>
                  <Text style={[styles.quantityLabel, { color: colors.mutedForeground, fontFamily: 'Inter_500Medium' }]}>
                    CURRENT
                  </Text>
                  <Text style={[styles.quantityValue, { color: colors.foreground, fontFamily: 'Inter_600SemiBold' }]}>
                    {item[totalQuantityHeader] || '0'}
                  </Text>
                </View>
                <View style={styles.addQuantityCopy}>
                  <Text style={[styles.quantityLabel, { color: confirmedRowIndexes.has(index) ? colors.primary : colors.mutedForeground, fontFamily: 'Inter_500Medium' }]}>
                    ADD TO QUANTITY
                  </Text>
                  <TextInput
                    value={item[addQuantityHeader] ?? '0'}
                    onChangeText={(value) => updateRow(index, value)}
                    editable={confirmedRowIndexes.has(index)}
                    keyboardType="number-pad"
                    selectTextOnFocus
                    style={[styles.quantityInput, { color: confirmedRowIndexes.has(index) ? colors.foreground : colors.mutedForeground, backgroundColor: confirmedRowIndexes.has(index) ? colors.background : colors.muted, borderColor: colors.border, fontFamily: 'Inter_600SemiBold' }]}
                    testID={`tcgplayer-add-quantity-${index}`}
                  />
                </View>
              </View>
            </View>
          )}
          ListEmptyComponent={
            <Text style={[styles.emptyBody, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
              The imported file contains no listings.
            </Text>
          }
        />
      )}
      <Modal
        visible={Boolean(pickerReview)}
        animationType="slide"
        transparent
        onRequestClose={() => setPickerReview(null)}
      >
        <View style={[styles.modalBackdrop, { backgroundColor: `${colors.foreground}99` }]}>
          <View style={[styles.modalCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={styles.modalHeader}>
              <View style={styles.modalTitleCopy}>
                <Text style={[styles.modalTitle, { color: colors.foreground, fontFamily: 'Inter_700Bold' }]}>
                  Choose listing
                </Text>
                <Text style={[styles.modalSubtitle, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]} numberOfLines={2}>
                  {pickerReview?.cardName}
                </Text>
              </View>
              <TouchableOpacity onPress={() => setPickerReview(null)} hitSlop={10} accessibilityLabel="Close listing picker">
                <Feather name="x" size={22} color={colors.foreground} />
              </TouchableOpacity>
            </View>
            <TextInput
              value={pickerSearch}
              onChangeText={setPickerSearch}
              placeholder="Search listings"
              placeholderTextColor={colors.mutedForeground}
              style={[styles.searchInput, { color: colors.foreground, backgroundColor: colors.background, borderColor: colors.border, fontFamily: 'Inter_400Regular' }]}
              testID="tcgplayer-listing-search"
            />
            <FlatList
              data={pickerCandidates}
              keyExtractor={(index) => `picker-row-${index}`}
              contentContainerStyle={styles.pickerList}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item: index }) => {
                const row = inventory?.rows[index];
                if (!row) return null;
                return (
                  <TouchableOpacity
                    style={[styles.pickerRow, { borderColor: colors.border }]}
                    onPress={() => confirmMapping(pickerReview?.entryId ?? '', index)}
                    disabled={busy}
                    testID={`choose-tcgplayer-listing-${index}`}
                  >
                    <View style={styles.rowCopy}>
                      <Text style={[styles.productName, { color: colors.foreground, fontFamily: 'Inter_600SemiBold' }]} numberOfLines={2}>
                        {row['Product Name'] || 'Unnamed listing'}
                      </Text>
                      <Text style={[styles.productMeta, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]} numberOfLines={2}>
                        {[row['Set Name'], row.Condition, row['TCGplayer ID']].filter(Boolean).join(' · ')}
                      </Text>
                    </View>
                    <Feather name="chevron-right" size={18} color={colors.primary} />
                  </TouchableOpacity>
                );
              }}
              ListEmptyComponent={
                <Text style={[styles.emptyBody, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
                  No imported listings match that search.
                </Text>
              }
            />
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    paddingHorizontal: 16,
    paddingBottom: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: { fontSize: 26, letterSpacing: -0.5 },
  subtitle: { fontSize: 13, marginTop: 3 },
  emptyWrap: { flex: 1, alignItems: 'center', paddingHorizontal: 28, paddingTop: 62 },
  heroIcon: { width: 64, height: 64, borderRadius: 20, alignItems: 'center', justifyContent: 'center', marginBottom: 18 },
  emptyTitle: { fontSize: 20, textAlign: 'center' },
  emptyBody: { fontSize: 14, lineHeight: 21, textAlign: 'center', marginTop: 10, maxWidth: 380 },
  primaryButton: { minHeight: 44, borderRadius: 10, paddingHorizontal: 14, flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center' },
  primaryButtonText: { fontSize: 13 },
  note: { fontSize: 12, textAlign: 'center', marginTop: 14 },
  list: { paddingHorizontal: 16, gap: 10 },
  contentGap: { gap: 12, marginBottom: 2 },
  summaryCard: { padding: 14, borderWidth: 1, borderRadius: 14, gap: 12 },
  summaryTop: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  summaryIcon: { width: 36, height: 36, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  summaryCopy: { flex: 1 },
  summaryTitle: { fontSize: 15 },
  summaryBody: { fontSize: 12, marginTop: 3 },
  helpText: { fontSize: 12, lineHeight: 18 },
  actionRow: { flexDirection: 'row', gap: 8 },
  secondaryButton: { flex: 1, minHeight: 42, borderRadius: 10, borderWidth: 1, flexDirection: 'row', gap: 7, alignItems: 'center', justifyContent: 'center' },
  secondaryButtonText: { fontSize: 12 },
  actionButton: { flex: 1 },
  matchSummary: { fontSize: 12 },
  sectionLabel: { fontSize: 11, letterSpacing: 0.8 },
  reviewSection: { gap: 10 },
  reviewHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  reviewCount: { fontSize: 11 },
  reviewCard: { borderWidth: 1, borderRadius: 13, padding: 13, gap: 10 },
  reviewReason: { fontSize: 12, lineHeight: 18 },
  rowCard: { borderWidth: 1, borderRadius: 13, padding: 13, gap: 12 },
  rowTop: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  rowCopy: { flex: 1 },
  productName: { fontSize: 14, lineHeight: 19 },
  productMeta: { fontSize: 11, marginTop: 4 },
  price: { fontSize: 14 },
  quantityRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  quantityLabel: { fontSize: 10, letterSpacing: 0.4 },
  quantityValue: { fontSize: 14, marginTop: 4 },
  addQuantityCopy: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  quantityInput: { width: 70, height: 38, borderWidth: 1, borderRadius: 9, textAlign: 'center', fontSize: 15 },
  modalBackdrop: { flex: 1, justifyContent: 'flex-end' },
  modalCard: { maxHeight: '88%', minHeight: '55%', borderTopLeftRadius: 22, borderTopRightRadius: 22, borderWidth: 1, padding: 18, gap: 14 },
  modalHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 },
  modalTitleCopy: { flex: 1 },
  modalTitle: { fontSize: 20 },
  modalSubtitle: { fontSize: 13, lineHeight: 18, marginTop: 4 },
  searchInput: { height: 44, borderWidth: 1, borderRadius: 10, paddingHorizontal: 13, fontSize: 14 },
  pickerList: { gap: 9, paddingBottom: 18 },
  pickerRow: { minHeight: 64, borderWidth: 1, borderRadius: 11, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 10 },
});
import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TextInput,
  ActivityIndicator,
  TouchableOpacity,
  Alert,
  Platform,
  Modal,
  ScrollView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { useColors } from '@/hooks/useColors';
import { type CardProduct, searchCardsWithCache } from '@/services/pricecharting';
import { CardResultItem } from '@/components/CardResultItem';
import { useBatchQueue } from '@/context/BatchQueueContext';
import { useOfflineBooth } from '@/context/OfflineBoothContext';

const API_BASE =
  process.env.EXPO_PUBLIC_DOMAIN
    ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`
    : '/api';

interface IdentificationCandidate {
  cardName: string;
  setName?: string;
  cardNumber?: string;
  confidence?: number;
}

async function identifyCardFromImage(
  base64: string,
  mimeType: string,
): Promise<IdentificationCandidate[]> {
  const resp = await fetch(`${API_BASE}/identify-card`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageBase64: base64, mimeType }),
  });
  if (!resp.ok) throw new Error(`Identify failed: ${resp.status}`);
  const data = await resp.json();
  const candidates = Array.isArray(data.candidates)
    ? data.candidates.filter(
        (candidate: unknown): candidate is IdentificationCandidate =>
          !!candidate &&
          typeof candidate === 'object' &&
          typeof (candidate as IdentificationCandidate).cardName === 'string',
      )
    : [];
  if (candidates.length) return candidates;

  const cardName = typeof data.cardName === 'string' ? data.cardName : '';
  return cardName ? [{ cardName }] : [];
}

export default function SearchScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CardProduct[]>([]);
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [candidates, setCandidates] = useState<IdentificationCandidate[]>([]);
  const [candidatePickerVisible, setCandidatePickerVisible] = useState(false);
  const [cachedResultsAt, setCachedResultsAt] = useState<string | null>(null);
  const { items: batchItems, addCard, isReady: batchReady } = useBatchQueue();
  const { pendingOperations, isSyncing, lastSyncMessage, queueSearch, queueIdentification, retryPending } =
    useOfflineBooth();

  const runSearch = useCallback(async (q: string) => {
    if (!q.trim()) return;
    setLoading(true);
    setError(null);
    setSearched(true);
    try {
      const result = await searchCardsWithCache(q.trim());
      setResults(result.products);
      setCachedResultsAt(result.source === 'cache' ? result.fetchedAt : null);
      if (result.source === 'cache') {
        try {
          await queueSearch(q.trim());
        } catch (error: unknown) {
          Alert.alert(
            'Offline queue full',
            error instanceof Error ? error.message : 'Could not queue the saved search.',
          );
        }
      }
    } catch {
      try {
        await queueSearch(q.trim());
      } catch (queueError: unknown) {
        setError(queueError instanceof Error ? queueError.message : 'Could not queue the search.');
        setResults([]);
        setLoading(false);
        return;
      }
      setCachedResultsAt(null);
      setError('Could not reach PriceCharting and no saved match was found. Your search is queued for sync.');
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [queueSearch]);

  const handleSearch = useCallback(() => runSearch(query), [query, runSearch]);

  const handleClear = () => {
    setQuery('');
    setResults([]);
    setSearched(false);
    setError(null);
    setCachedResultsAt(null);
  };

  const handleCameraSearch = async () => {
    // Request camera permission
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert(
        'Camera permission required',
        'Please allow camera access in Settings to search by photo.',
      );
      return;
    }

    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images'],
      quality: 0.4,   // lower quality = smaller base64 payload
      base64: true,
      allowsEditing: false,
    });

    if (result.canceled || !result.assets?.[0]) return;

    const asset = result.assets[0];
    const base64 = asset.base64;
    if (!base64) {
      Alert.alert('Error', 'Could not read image data.');
      return;
    }

    const mimeType = asset.mimeType ?? 'image/jpeg';

    setScanning(true);
    setError(null);
    try {
      const matchedCandidates = await identifyCardFromImage(base64, mimeType);
      if (!matchedCandidates.length) {
        Alert.alert('No card found', 'Could not identify a card in that photo. Try a clearer shot of the card name.');
        return;
      }
      setCandidates(matchedCandidates);
      setCandidatePickerVisible(true);
    } catch {
      try {
        await queueIdentification(base64, mimeType);
        setError('Camera scan saved for sync. We’ll identify it as soon as the connection returns.');
      } catch (error: unknown) {
        setError(error instanceof Error ? error.message : 'Could not identify card. Try again or type the name manually.');
      }
    } finally {
      setScanning(false);
    }
  };

  const handleCardPress = (item: CardProduct) => {
    router.push({
      pathname: '/card/[id]',
      params: {
        id: String(item.id),
        name: item['product-name'],
        series: item['console-name'],
        loose: String(item['loose-price'] ?? 0),
        cib: String(item['cib-price'] ?? 0),
        newPrice: String(item['new-price'] ?? 0),
        graded: String(item['graded-price'] ?? 0),
        stale: cachedResultsAt ? '1' : '0',
      },
    });
  };

  const handleAddToBatch = (item: CardProduct) => {
    if (!batchReady) {
      Alert.alert('Preparing queue', 'Your saved batch is still loading. Please try again in a moment.');
      return;
    }
    if (addCard(item, !!cachedResultsAt)) {
      Alert.alert('Added to batch', `${item['product-name']} is ready in your print queue.`);
    } else {
      Alert.alert(
        'Already in queue',
        'This card is already in the batch. Open Batch Mode and choose Add copy if you need another label.',
      );
    }
  };

  const handleCandidateSelect = async (candidate: IdentificationCandidate) => {
    const searchTerm = [candidate.cardName, candidate.setName, candidate.cardNumber]
      .filter(Boolean)
      .join(' ');
    setCandidatePickerVisible(false);
    setQuery(searchTerm);
    await runSearch(searchTerm);
  };

  const topPad = Platform.OS === 'web' ? 67 : insets.top;
  const isBusy = loading || scanning;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View
        style={[
          styles.header,
          { paddingTop: topPad + 14, backgroundColor: colors.background },
        ]}
      >
        <View style={styles.titleRow}>
          <View>
            <Text
              style={[
                styles.title,
                { color: colors.foreground, fontFamily: 'Inter_700Bold' },
              ]}
            >
              PriceTag
            </Text>
            <Text
              style={[
                styles.subtitle,
                { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' },
              ]}
            >
              Prices via PriceCharting · free
            </Text>
          </View>
          <TouchableOpacity
            onPress={() => router.push('/batch')}
            style={[styles.batchButton, { backgroundColor: colors.accent, borderColor: colors.border }]}
            accessibilityLabel="Open batch print queue"
            testID="open-batch-queue"
          >
            <Feather name="layers" size={17} color={colors.primary} />
            <Text style={[styles.batchCount, { color: colors.primary, fontFamily: 'Inter_700Bold' }]}>
              {batchItems.length}
            </Text>
          </TouchableOpacity>
        </View>

        {/* Search bar */}
        <View
          style={[
            styles.searchRow,
            { backgroundColor: colors.card, borderColor: colors.border },
          ]}
        >
          <Feather
            name="search"
            size={18}
            color={colors.mutedForeground}
            style={{ opacity: 0.8 }}
          />
          <TextInput
            style={[
              styles.input,
              { color: colors.foreground, fontFamily: 'Inter_400Regular' },
            ]}
            placeholder="Charizard, Black Lotus, Pikachu…"
            placeholderTextColor={colors.mutedForeground}
            value={query}
            onChangeText={setQuery}
            onSubmitEditing={handleSearch}
            returnKeyType="search"
            autoCorrect={false}
            autoCapitalize="none"
          />
          {query.length > 0 && (
            <TouchableOpacity onPress={handleClear} hitSlop={8}>
              <Feather name="x" size={16} color={colors.mutedForeground} />
            </TouchableOpacity>
          )}
        </View>

        {/* Action buttons row */}
        <View style={styles.btnRow}>
          <TouchableOpacity
            style={[
              styles.searchBtn,
              { flex: 1, backgroundColor: isBusy || !query.trim() ? colors.muted : colors.primary },
            ]}
            onPress={handleSearch}
            activeOpacity={0.8}
            disabled={isBusy || !query.trim()}
          >
            {loading ? (
              <ActivityIndicator size="small" color={colors.primaryForeground} />
            ) : (
              <Text
                style={[
                  styles.btnText,
                  {
                    color: !query.trim() ? colors.mutedForeground : colors.primaryForeground,
                    fontFamily: 'Inter_600SemiBold',
                  },
                ]}
              >
                Search
              </Text>
            )}
          </TouchableOpacity>

          {/* Camera button */}
          <TouchableOpacity
            style={[
              styles.cameraBtn,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}
            onPress={handleCameraSearch}
            activeOpacity={0.8}
            disabled={isBusy}
          >
            {scanning ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : (
              <Feather name="camera" size={20} color={colors.primary} />
            )}
          </TouchableOpacity>
        </View>

        {scanning && (
          <Text style={[styles.scanningHint, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
            Identifying card…
          </Text>
        )}
        {(cachedResultsAt || pendingOperations.length > 0 || lastSyncMessage) && (
          <View style={[styles.boothBanner, { backgroundColor: colors.accent, borderColor: colors.border }]}>
            <Feather name={cachedResultsAt ? 'wifi-off' : 'clock'} size={15} color={colors.primary} />
            <View style={styles.boothCopy}>
              <Text style={[styles.boothTitle, { color: colors.foreground, fontFamily: 'Inter_600SemiBold' }]}>
                {cachedResultsAt
                  ? 'Offline Booth Mode'
                  : lastSyncMessage
                    ? 'Booth sync complete'
                  : `${pendingOperations.length} item${pendingOperations.length === 1 ? '' : 's'} waiting to sync`}
              </Text>
              <Text style={[styles.boothBody, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
                {cachedResultsAt
                  ? `Showing saved prices from ${new Date(cachedResultsAt).toLocaleDateString()}. Labels will be marked stale.`
                  : lastSyncMessage
                    ? lastSyncMessage
                  : isSyncing
                    ? 'Syncing saved searches and scans…'
                    : 'Saved requests retry automatically when a connection returns.'}
              </Text>
            </View>
            {pendingOperations.length > 0 && (
              <TouchableOpacity onPress={() => retryPending()} disabled={isSyncing} hitSlop={8}>
                {isSyncing ? (
                  <ActivityIndicator size="small" color={colors.primary} />
                ) : (
                  <Feather name="refresh-cw" size={17} color={colors.primary} />
                )}
              </TouchableOpacity>
            )}
          </View>
        )}
      </View>

      {/* Results / States */}
      {error ? (
        <View style={styles.center}>
          <Feather name="wifi-off" size={44} color={colors.mutedForeground} />
          <Text
            style={[
              styles.stateTitle,
              { color: colors.foreground, fontFamily: 'Inter_600SemiBold' },
            ]}
          >
            Connection error
          </Text>
          <Text
            style={[
              styles.stateBody,
              { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' },
            ]}
          >
            {error}
          </Text>
          <TouchableOpacity
            onPress={handleSearch}
            style={[styles.retryBtn, { borderColor: colors.border }]}
          >
            <Text
              style={[
                styles.retryText,
                { color: colors.primary, fontFamily: 'Inter_500Medium' },
              ]}
            >
              Retry
            </Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={results}
          keyExtractor={(item) => String(item.id)}
          renderItem={({ item }) => (
            <CardResultItem
              item={item}
              onPress={() => handleCardPress(item)}
              onAddToBatch={() => handleAddToBatch(item)}
            />
          )}
          contentContainerStyle={[
            styles.list,
            results.length === 0 && styles.listEmpty,
            Platform.OS === 'web' && { paddingBottom: 34 },
          ]}
          ListEmptyComponent={
            searched && !isBusy ? (
              <View style={styles.center}>
                <Feather
                  name="layers"
                  size={48}
                  color={colors.mutedForeground}
                  style={{ opacity: 0.5 }}
                />
                <Text
                  style={[
                    styles.stateTitle,
                    { color: colors.foreground, fontFamily: 'Inter_600SemiBold' },
                  ]}
                >
                  No cards found
                </Text>
                <Text
                  style={[
                    styles.stateBody,
                    {
                      color: colors.mutedForeground,
                      fontFamily: 'Inter_400Regular',
                    },
                  ]}
                >
                  Try a different name or set name
                </Text>
              </View>
            ) : !searched ? (
              <View style={styles.center}>
                <Feather
                  name="credit-card"
                  size={52}
                  color={colors.mutedForeground}
                  style={{ opacity: 0.3 }}
                />
                <Text
                  style={[
                    styles.stateTitle,
                    {
                      color: colors.mutedForeground,
                      fontFamily: 'Inter_600SemiBold',
                    },
                  ]}
                >
                  Search for a card
                </Text>
                <Text
                  style={[
                    styles.stateBody,
                    {
                      color: colors.mutedForeground,
                      fontFamily: 'Inter_400Regular',
                    },
                  ]}
                >
                  Type a name or tap 📷 to scan a card
                </Text>
              </View>
            ) : null
          }
          scrollEnabled={results.length > 0}
        />
      )}

      <Modal
        visible={candidatePickerVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setCandidatePickerVisible(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={[styles.candidateSheet, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={styles.sheetHeader}>
              <View>
                <Text style={[styles.sheetTitle, { color: colors.foreground, fontFamily: 'Inter_700Bold' }]}>
                  Choose your card
                </Text>
                <Text
                  style={[styles.sheetBody, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}
                >
                  Camera matches are suggestions. Pick the closest result to search PriceCharting.
                </Text>
              </View>
              <TouchableOpacity onPress={() => setCandidatePickerVisible(false)} hitSlop={8}>
                <Feather name="x" size={20} color={colors.mutedForeground} />
              </TouchableOpacity>
            </View>

            <ScrollView contentContainerStyle={styles.candidateList}>
              {candidates.map((candidate, index) => {
                const description = [candidate.setName, candidate.cardNumber].filter(Boolean).join(' · ');
                return (
                  <TouchableOpacity
                    key={`${candidate.cardName}-${candidate.setName ?? ''}-${index}`}
                    onPress={() => handleCandidateSelect(candidate)}
                    style={[styles.candidateRow, { borderColor: colors.border, backgroundColor: colors.background }]}
                  >
                    <View style={styles.candidateInfo}>
                      <Text
                        style={[styles.candidateName, { color: colors.foreground, fontFamily: 'Inter_600SemiBold' }]}
                        numberOfLines={1}
                      >
                        {candidate.cardName}
                      </Text>
                      {!!description && (
                        <Text
                          style={[styles.candidateDescription, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}
                          numberOfLines={1}
                        >
                          {description}
                        </Text>
                      )}
                    </View>
                    <View style={styles.candidateRight}>
                      {typeof candidate.confidence === 'number' && (
                        <Text style={[styles.confidence, { color: colors.primary, fontFamily: 'Inter_600SemiBold' }]}>
                          {Math.round(candidate.confidence * 100)}%
                        </Text>
                      )}
                      <Feather name="arrow-right" size={17} color={colors.mutedForeground} />
                    </View>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>

            <TouchableOpacity
              onPress={() => setCandidatePickerVisible(false)}
              style={[styles.manualSearchButton, { borderColor: colors.primary }]}
            >
              <Text style={[styles.manualSearchText, { color: colors.primary, fontFamily: 'Inter_600SemiBold' }]}>
                Type it manually instead
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingHorizontal: 16, paddingBottom: 14, gap: 8 },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: 28 },
  subtitle: { fontSize: 13, marginTop: -4, marginBottom: 4 },
  batchButton: {
    minWidth: 46,
    height: 38,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    borderRadius: 12,
    borderWidth: 1,
  },
  batchCount: { fontSize: 14 },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    height: 48,
    gap: 8,
  },
  input: { flex: 1, fontSize: 15, height: 48 },
  btnRow: { flexDirection: 'row', gap: 8 },
  searchBtn: {
    height: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnText: { fontSize: 16 },
  cameraBtn: {
    width: 48,
    height: 48,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scanningHint: { fontSize: 13, textAlign: 'center', marginTop: -4 },
  boothBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 11,
    paddingVertical: 9,
    gap: 8,
    marginTop: 2,
  },
  boothCopy: { flex: 1, gap: 2 },
  boothTitle: { fontSize: 12 },
  boothBody: { fontSize: 11, lineHeight: 15 },
  list: { paddingTop: 10, paddingBottom: 32 },
  listEmpty: { flex: 1 },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: 32,
  },
  stateTitle: { fontSize: 18, marginTop: 12 },
  stateBody: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
  retryBtn: {
    marginTop: 8,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 24,
    paddingVertical: 10,
  },
  retryText: { fontSize: 14 },
  modalBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0, 0, 0, 0.4)' },
  candidateSheet: {
    maxHeight: '72%',
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderWidth: 1,
    padding: 18,
    gap: 14,
  },
  sheetHeader: { flexDirection: 'row', gap: 16, alignItems: 'flex-start' },
  sheetTitle: { fontSize: 19 },
  sheetBody: { fontSize: 13, lineHeight: 19, marginTop: 4, maxWidth: 290 },
  candidateList: { gap: 8 },
  candidateRow: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 13,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  candidateInfo: { flex: 1 },
  candidateName: { fontSize: 15 },
  candidateDescription: { fontSize: 12, marginTop: 3 },
  candidateRight: { alignItems: 'flex-end', gap: 4 },
  confidence: { fontSize: 11 },
  manualSearchButton: { alignSelf: 'center', borderWidth: 1, borderRadius: 9, paddingHorizontal: 16, paddingVertical: 10 },
  manualSearchText: { fontSize: 13 },
});

import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TextInput,
  ActivityIndicator,
  TouchableOpacity,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { type CardProduct, searchCards } from '@/services/pricecharting';
import { CardResultItem } from '@/components/CardResultItem';

export default function SearchScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CardProduct[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  const handleSearch = useCallback(async () => {
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    setSearched(true);
    try {
      const data = await searchCards(query.trim());
      setResults(data);
    } catch {
      setError('Could not reach PriceCharting. Check your connection.');
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [query]);

  const handleClear = () => {
    setQuery('');
    setResults([]);
    setSearched(false);
    setError(null);
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
      },
    });
  };

  const topPad = Platform.OS === 'web' ? 67 : insets.top;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
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
          Card Search
        </Text>
        <Text
          style={[
            styles.subtitle,
            { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' },
          ]}
        >
          Prices via PriceCharting · free
        </Text>

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

        <TouchableOpacity
          style={[
            styles.searchBtn,
            {
              backgroundColor:
                loading || !query.trim()
                  ? colors.muted
                  : colors.primary,
            },
          ]}
          onPress={handleSearch}
          activeOpacity={0.8}
          disabled={loading || !query.trim()}
        >
          {loading ? (
            <ActivityIndicator size="small" color={colors.primaryForeground} />
          ) : (
            <Text
              style={[
                styles.searchBtnText,
                {
                  color:
                    !query.trim()
                      ? colors.mutedForeground
                      : colors.primaryForeground,
                  fontFamily: 'Inter_600SemiBold',
                },
              ]}
            >
              Search
            </Text>
          )}
        </TouchableOpacity>
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
            />
          )}
          contentContainerStyle={[
            styles.list,
            results.length === 0 && styles.listEmpty,
            Platform.OS === 'web' && { paddingBottom: 34 },
          ]}
          ListEmptyComponent={
            searched && !loading ? (
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
                  Pokémon, MTG, Yu-Gi-Oh and more
                </Text>
              </View>
            ) : null
          }
          scrollEnabled={results.length > 0}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingHorizontal: 16, paddingBottom: 14, gap: 8 },
  title: { fontSize: 28 },
  subtitle: { fontSize: 13, marginTop: -4, marginBottom: 4 },
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
  searchBtn: {
    height: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchBtnText: { fontSize: 16 },
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
});

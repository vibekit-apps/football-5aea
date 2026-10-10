// The first screen. A working example of the one pattern every screen uses:
// load from this app's server with api() and show errors in words. While the
// server wakes, the app's frame covers the screen on its own (app/_layout.tsx).
// Replace it with the real app.
import Ionicons from '@expo/vector-icons/Ionicons';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../lib/api';

type Item = { id: string; text: string; createdAt: string };

export default function Home() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      setItems(await api<Item[]>('GET', '/api/items'));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const add = async () => {
    const text = draft.trim();
    if (!text) return;
    setError('');
    try {
      const item = await api<Item>('POST', '/api/items', { text });
      setItems((prev) => [item, ...(prev || [])]);
      setDraft('');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <SafeAreaView style={styles.screen}>
      <Text style={styles.title}>My App</Text>
      <View style={styles.row}>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={add}
          placeholder="Add an item"
          placeholderTextColor="#8a8aa0"
          returnKeyType="done"
        />
        <Pressable style={styles.button} onPress={add} accessibilityRole="button" accessibilityLabel="Add">
          <Ionicons name="add" size={24} color="#fff" />
        </Pressable>
      </View>
      {!!error && (
        <Pressable onPress={load} accessibilityRole="button">
          <Text style={styles.error}>{error} Tap to retry.</Text>
        </Pressable>
      )}
      {items === null && !error ? (
        <ActivityIndicator style={{ marginTop: 32 }} />
      ) : (
        <FlatList
          data={items || []}
          keyExtractor={(i) => i.id}
          renderItem={({ item }) => <Text style={styles.item}>{item.text}</Text>}
          ListEmptyComponent={<Text style={styles.note}>Nothing yet. Add the first item.</Text>}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: 20, backgroundColor: '#0f0f14' },
  title: { fontSize: 28, fontWeight: '700', color: '#fff', marginTop: 16, marginBottom: 12 },
  row: { flexDirection: 'row', gap: 10, marginBottom: 12 },
  input: { flex: 1, backgroundColor: '#1c1c26', color: '#fff', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16 },
  button: { backgroundColor: '#7c5cff', borderRadius: 12, paddingHorizontal: 14, justifyContent: 'center', alignItems: 'center' },
  item: { color: '#e8e8f0', fontSize: 17, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#2a2a36' },
  note: { color: '#8a8aa0', fontSize: 15, marginVertical: 8 },
  error: { color: '#f87171', fontSize: 15, marginVertical: 8 },
});

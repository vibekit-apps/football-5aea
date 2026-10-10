// Covers the whole app while its server wakes up (app/_layout.tsx shows it,
// lib/api.ts decides when). The words are the platform's own, the same ones
// its web waking page shows, so this component only lays them out. PLATFORM
// CONTRACT: keep it; restyle it to match the app if you like.
import { useEffect, useRef } from 'react';
import { ActivityIndicator, Animated, Easing, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import type { WakingState } from '../lib/api';

// The bar fills quickly at first, then slows, and never quite finishes on its
// own: a cold start takes around 40 s and the screen leaves the moment the
// server answers, so an honest bar approaches the end instead of claiming it.
const FILL_MS = 45_000;

export function WakingScreen({ state }: { state: NonNullable<WakingState> }) {
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const run = Animated.timing(progress, { toValue: 0.92, duration: FILL_MS, easing: Easing.out(Easing.exp), useNativeDriver: false });
    run.start();
    return () => run.stop();
  }, [progress]);
  const width = progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });

  return (
    <View style={styles.screen} accessibilityLiveRegion="polite">
      <ActivityIndicator size="large" color="#a78bfa" />
      <Text style={styles.title}>Waking up</Text>
      <Text style={styles.message}>{state.message}</Text>
      <View style={styles.track}>
        <Animated.View style={[styles.fill, { width }]} />
      </View>
      {state.upsell && (
        <View style={styles.card}>
          <Text style={styles.cardText}>{state.upsell.text}</Text>
          <Pressable style={styles.cta} onPress={() => Linking.openURL(state.upsell!.url)} accessibilityRole="link">
            <Text style={styles.ctaText}>{state.upsell.label}</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#0b0b12', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, zIndex: 100 },
  title: { color: '#fff', fontSize: 26, fontWeight: '700', marginTop: 24 },
  message: { color: '#9a9ab0', fontSize: 15, lineHeight: 21, textAlign: 'center', marginTop: 8, maxWidth: 320 },
  track: { width: '70%', maxWidth: 260, height: 4, borderRadius: 2, backgroundColor: '#23233a', marginTop: 28, overflow: 'hidden' },
  fill: { height: 4, borderRadius: 2, backgroundColor: '#a78bfa' },
  card: { marginTop: 40, alignSelf: 'stretch', maxWidth: 360, backgroundColor: '#15151f', borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: '#2c2c40', padding: 18, alignItems: 'center' },
  cardText: { color: '#d8d8e8', fontSize: 15, lineHeight: 21, textAlign: 'center' },
  cta: { marginTop: 14, backgroundColor: '#7c5cff', borderRadius: 12, paddingVertical: 12, paddingHorizontal: 20 },
  ctaText: { color: '#fff', fontSize: 15, fontWeight: '600' },
});

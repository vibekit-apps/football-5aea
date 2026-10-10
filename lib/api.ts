// Talk to this app's own server (server.js) from the phone and from the web.
//
//   import { api } from '../lib/api';
//   const items = await api<Item[]>('GET', '/api/items');
//   await api('POST', '/api/items', { text: 'Milk' });
//
// Why this exists instead of bare fetch(): the app's server SLEEPS when nobody
// has used it for a while, and waking it takes up to a minute. While it wakes,
// the platform answers for it with `503 {"placeholder":"waking","retryAfter":5}`.
// That answer means the request never reached the app, so it is always safe to
// send again, and api() does, for up to a minute. Meanwhile the app's frame
// (app/_layout.tsx) covers the screen with components/WakingScreen.tsx, using
// the words the platform sent, and takes it away the moment the server
// answers; screens do nothing. A network error is different: a write may have
// landed before the connection dropped, so a write is not repeated and the
// error says to try again.
//
// The session token (from /api/auth/login or /signup) is kept in the phone's
// secure storage (localStorage on the web) and sent on every call. It is
// cleared only when THIS app's server answers 401, never because the server
// was asleep.
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';

/** The app's server. On a phone it is the address Expo Go opened the app from
 *  (the platform puts it in the config it serves); on the web, this page's own. */
export const API_ORIGIN =
  Platform.OS === 'web' ? '' : String((Constants.expoConfig?.extra as { apiOrigin?: string } | undefined)?.apiOrigin || '');

const TOKEN_KEY = 'session';

export async function getToken(): Promise<string | null> {
  if (Platform.OS === 'web') return globalThis.localStorage?.getItem(TOKEN_KEY) ?? null;
  return SecureStore.getItemAsync(TOKEN_KEY);
}

export async function setToken(token: string | null): Promise<void> {
  if (Platform.OS === 'web') {
    if (token) globalThis.localStorage?.setItem(TOKEN_KEY, token);
    else globalThis.localStorage?.removeItem(TOKEN_KEY);
    return;
  }
  if (token) await SecureStore.setItemAsync(TOKEN_KEY, token);
  else await SecureStore.deleteItemAsync(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

const WAKE_BUDGET_MS = 60_000;

/** What the platform says while the app's server is not up yet: its sentence,
 *  and (while it wakes) the offer to keep it always on. The words come from
 *  the platform, the same ones its web waking page shows. */
export type WakingState = {
  message: string;
  upsell: { text: string; label: string; url: string } | null;
} | null;

let current: WakingState = null;
const listeners = new Set<(w: WakingState) => void>();
function setWaking(next: WakingState) {
  current = next;
  for (const l of listeners) l(next);
}

/** Non-null while api() is waiting for the app's server to come up. */
export function useWakingState(): WakingState {
  const [state, set] = useState<WakingState>(current);
  useEffect(() => {
    listeners.add(set);
    set(current);
    return () => { listeners.delete(set); };
  }, []);
  return state;
}

/** True while api() is waiting for the app's server to come up. */
export function useWaking(): boolean {
  return useWakingState() !== null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A JSON request to this app's server. Resolves with the parsed body;
 *  throws ApiError with a message fit to show the user. */
export async function api<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const deadline = Date.now() + WAKE_BUDGET_MS;
  const token = await getToken();
  for (let attempt = 0; ; attempt++) {
    let res: Response | null = null;
    try {
      res = await fetch(API_ORIGIN + path, {
        method,
        headers: {
          // Asking for JSON is what makes the platform answer a sleeping
          // app with JSON too, instead of its HTML "Waking up" page.
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      res = null;
    }

    let wait: number;
    if (res) {
      const data: any = await res.json().catch(() => null);
      if (!(data && typeof data.placeholder === 'string')) {
        // The app itself answered.
        setWaking(null);
        if (res.status === 401) await setToken(null);
        if (!res.ok) throw new ApiError((data && (data.error || data.message)) || `Request failed (${res.status})`, res.status);
        return data as T;
      }
      // The platform answered for the app. Only waking, deploying and
      // restarting come with retryAfter; anything else will not fix itself.
      if (!data.retryAfter) {
        setWaking(null);
        throw new ApiError(data.error || 'This app is not available right now.', res.status);
      }
      wait = data.retryAfter * 1000;
      const u = data.upsell;
      setWaking({
        message: String(data.error || 'Starting up…'),
        upsell: u && u.text && u.label && u.url ? { text: String(u.text), label: String(u.label), url: String(u.url) } : null,
      });
    } else {
      if (method !== 'GET') {
        setWaking(null);
        throw new ApiError('Could not reach the server. Check your connection and try again.', 0);
      }
      // No answer at all (offline, or a connection that dropped): retried
      // quietly; the full-screen state is only for the platform saying so.
      wait = Math.min(1000 * 2 ** attempt, 5000);
    }
    if (Date.now() + wait > deadline) {
      setWaking(null);
      throw new ApiError('The server is taking a while to wake up. Try again in a moment.', 503);
    }
    await sleep(wait);
  }
}

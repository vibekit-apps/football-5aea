# Template: Native app (Expo)

A real phone app, written in React Native with Expo. The user runs it on their
own phone in the free **Expo Go** app, and the same code is also a website at
this app's address. It is a working app to build ON, not a placeholder.

## What's already built and wired (do NOT rebuild it)

```
app/_layout.tsx   the app's frame (Expo Router: every file in app/ is a screen)
app/index.tsx     the first screen: a working list that loads and saves through the server
components/WakingScreen.tsx  what the app shows while its server wakes up (see below)
lib/api.ts        how every screen talks to the server (use it, never bare fetch)
server.js         the app's server: your JSON API, the phone updates, the website
lib/store.js      durable JSON storage for the server, atomic writes
lib/auth.js       accounts for the app's users: sign up, log in, session tokens
app.json          the app's name, icon and settings
package.json      dependencies and the platform's build marker (do not remove it)
```

## How this app gets to the phone

- **You never build or run it here.** Never run `expo start`, `expo run`,
  `npm install`, `npx expo install` or `expo export` in this workspace. There
  are no `node_modules` here on purpose. The platform installs and builds on
  **Deploy** (about a minute), then the phone picks up the new version.
- **Every turn that changes the app publishes itself.** Right after your reply
  the platform deploys what you changed (the first build and every edit after
  it), and once it is live it tells them to close and reopen the app in Expo
  Go. So end with what you changed, and never tell them to tap Deploy or to
  wait for "the next deploy". Deploy yourself only when they ask.
- **The platform hands them the phone link.** Its first-build message carries
  it (a page that opens the free Expo Go app, or helps install it), so don't
  repeat it in your reply; if they ask later, it is in AGENTS.md.
- **What you can verify:** the website (a screenshot of this app's address
  shows the same screens). You cannot see the phone; the user checks it in
  Expo Go.

## Platform contracts (do not change)

- `package.json` `"vibekit": {"build": "expo"}` and the `build` script. They
  are how the platform knows to build this as a phone app.
- `server.js`'s `/.vibekit/expo/*` handling, `currentRelease()` and `/health`.
  Expo Go loads the app from there; `/health` is how the platform knows the
  server is up.
- `lib/api.ts`'s `Accept: application/json` header and its waking retry, and
  the waking screen in `app/_layout.tsx` (`components/WakingScreen.tsx`). When
  nobody has used the app for a while its server sleeps, and waking takes up
  to a minute; `api()` waits that out while the frame covers every screen with
  the platform's waking message, then removes it the moment the server
  answers. Screens need nothing for it. Restyle `WakingScreen` to match the
  app if you like, but keep what it shows. Bare `fetch` would fail instead.
- `dist/` belongs to the platform (each build lands in `dist/releases/`).
  Never write into it.

## Adding a package

Only packages that run in Expo Go work, and the lockfile must match, so never
edit `package.json` dependencies by hand. Ask the platform to add one (see
TOOLS.md). A hand edit fails the next Deploy with "use the deps action".

## Where things go

| Adding | Put it in |
|---|---|
| A screen | a new file in `app/` (`app/settings.tsx` is `/settings`) |
| Talking to the server | `api()` from `lib/api.ts` |
| An API endpoint | the `routes` table in `server.js` |
| Saved data | `lib/store.js` via `store.read` / `store.write`, in `server.js` |
| Accounts | the `/api/auth/*` routes (already there) and `auth.userFor(req)` |
| A secret or API key | `process.env` in `server.js` only; screens ship inside the app |
| AI (a chat, a coach, a writer) | a `server.js` route that calls the built-in model (TOOLS.md §Runtime AI); screens call that route |
| An icon | `@expo/vector-icons`, one set per import: `import Ionicons from '@expo/vector-icons/Ionicons'` |
| Something to tap | a `Pressable` with `accessibilityRole="button"` (or `"link"`), plus `accessibilityLabel` when it shows only an icon. Without a role it is a plain box to VoiceOver and to the platform's page checks, which then find nothing to tap |
| The app's name and icon | `app.json` (`expo.name`, `expo.icon`) |

`lib/*.js` files run on the server (Node); `.ts`/`.tsx` files run on the phone
and in the browser. Never import a server file from a screen.

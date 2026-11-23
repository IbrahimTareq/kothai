# Kothai mobile (prototype)

An Expo dev build with one screen: server URL and capture token (kept in
`expo-secure-store`) and a "Check server" button that calls `/api/v1/info`.
A link shared to Kothai from another app (iOS share extension, Android
`text/*` intent, through `expo-share-intent`) is saved with `/api/v1/save`.
An "Ask test" panel posts a question to the server's `/api/ask` (or, with the
toggle on, to a scratch SSE endpoint on `localhost:5198`) and lists each
streamed chunk with its arrival time. Results are in `FINDINGS.md`.
One share at a time: there is no outbox yet, so a second share arriving while
the first is still saving replaces its status line and Retry target.
Not part of the root pnpm workspace: it installs on its own with npm, and
`ios/` / `android/` are generated, never committed.

Needs Node 22, Xcode and CocoaPods.

```sh
cd apps/mobile
npm install
LANG=en_US.UTF-8 npx expo prebuild --platform ios --clean   # regenerates ios/ (and the share extension) from app.json
npx expo run:ios                   # builds and installs the dev client
npx expo start --dev-client        # Metro
xcrun simctl launch <udid> app.kothai.mobile
```

`npx expo run:ios` builds and installs, but has exited 1 at `Simulator app did
not open fast enough` every time here, so launch the installed app with
`simctl` and start Metro yourself. CocoaPods crashes with `Unicode
Normalization not appropriate for ASCII-8BIT` when the shell has no UTF-8
locale, hence `LANG`. With more than one simulator booted, pick one:
`npx expo run:ios --device "<name or UDID>"`.

## A scratch server

Never point the app at a real library. From the repo root:

```sh
KOTHAI_DATA_DIR=$(mktemp -d) PORT=5199 node server/index.ts
```

In the app, enter `http://localhost:5199` (the simulator reaches the Mac at
`localhost`) and tap "Check server". A server with no `KOTHAI_PASSWORD` reports
sign-in `none`.

The scratch SSE endpoint on `localhost:5198` is a throwaway script: any POST
gets 20 `event: delta` / `data: {"text":"tick n"}` events 100 ms apart, then
the response closes.

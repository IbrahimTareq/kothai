# Expo share-capture prototype: findings

The three risks named in step 0 of
`docs/superpowers/specs/2026-11-19-cloud-architecture-design.md`, checked
against a self-hosted Kothai (plan:
`docs/superpowers/plans/2026-11-23-expo-share-prototype.md`).

Machine: Xcode 27.1, Expo SDK 58, React Native 0.88.1, expo-share-intent 9.
Simulator: iPhone 17 Pro on **iOS 26.2** (`D6C75DFA-…`). An iPhone 18 Pro on
iOS 27.0 is also booted; it was not used.

The device results below were observed by tapping through the app on the
simulator on 2026-11-23.

## 1. Share capture on iOS

**Status:** confirmed on the simulator (see Device result).

**Evidence so far:**
- The build carries the extension. `Kothai.app/PlugIns/ShareExtension.appex`
  is in the built and the installed app, bundle id
  `app.kothai.mobile.share-extension`, extension point
  `com.apple.share-services`, activation rules text + one web URL + one web
  page.
- The simulator entitlements of both app and extension carry the app group
  `group.app.kothai.mobile`.
- The save path works end to end under Node 22 with the app's own `share.ts`
  against a scratch server with a password: a capture token minted in
  Settings saves through `POST /api/v1/save`; no token, a bad token, a
  non-link and a dead server each come back as a readable failure, never a
  throw. `linkFrom` refuses `javascript:` / `data:` and strips trailing prose
  punctuation.
- The extension hands the share to the app (app group + `kothai://` URL); the
  app does the network call with `expo/fetch`. The extension itself makes no
  request.

**Device result (2026-11-23, iPhone 17 Pro simulator, iOS 26.2):** works. Safari on
`https://example.com/` → Share → the sheet lists **Kothai** (the label shows as
"Kothai", not "Kothai - Share Extension") → tap → Kothai comes to the front and
shows "Saved: https://example.com/". The scratch server's `/api/v1/notes` then
lists `https://example.com/` titled "Example Domain". The scratch server had no
password, so the capture token was not exercised on device (it was under Node).

## 2. SSE through `expo/fetch`

**Status:** stream reading and accumulation proved under Node 22;
`expo/fetch`'s incremental delivery confirmed on the simulator (see Device result).

**Evidence so far:**
- `stream.ts` (`streamAsk`) posts `{ question }` with
  `Accept: text/event-stream`, reads `response.body.getReader()` and reports
  each chunk raw with milliseconds since the request. Run under Node 22 with
  Node's fetch against the scratch SSE script (20 events, 100 ms apart):
  chunks arrived at +143, +241, +341 … +2059 ms, every gap 98–103 ms after
  the first. So the reader delivers chunks as they come, not at the end.
- Against a scratch Kothai with no AI configured, `/api/ask` answers
  `409 {"code":"llm_off"}` as plain JSON before any stream opens; the panel
  shows it as one chunk and "Done, HTTP 409". That is why the scratch SSE
  endpoint exists (ruling E3): Kothai's own event shape (`sources`, `delta`,
  `done`, `error`) was not streamed in this prototype.
- `expo/fetch` source (`expo/build/winter/fetch/FetchResponse.js`) builds
  `body` as a `ReadableStream` fed by native `didReceiveResponseData` events,
  so chunked delivery is the design. One catch read from the same code: if
  the response has already completed before the first `read()`, the whole
  body arrives as one chunk. Read the body straight after the response
  resolves, as `streamAsk` does.

**Device result (same simulator):** incremental. With the toggle on Scratch
SSE, the panel showed "Asking…" while events arrived at +115, +215, +316, +419,
+517, +619, +719, +819 ms … (about 100 ms apart), then "Done, HTTP 200". With
the toggle off, `/api/ask` on the no-AI scratch server answered 409 `llm_off` at
+22 ms, as under Node.

## 3. The iOS 26 share-extension bug

The spec cites a report of iOS 26 share extensions failing to open the app.

**Status:** not seen on **iOS 26.2 (simulator)**; a physical device is still unchecked.

**What to watch:** expo-share-intent's `ShareViewController.redirectToHostApp`
opens the app by walking the responder chain to `UIApplication` and calling
`open(kothai://dataUrl=…)`, then `completeRequest`. That is the mechanism the
iOS 26 reports concern. Failure looks like: the share sheet closes, Kothai
does not come to the front, and no "Saving …" line appears. If so, note
whether opening Kothai by hand afterwards picks the share up from the app
group, which would make the bug an annoyance rather than a lost share.

**Device result:** not seen on the iOS 26.2 simulator: the share sheet closed and
Kothai came to the front with the share on the first try. Not yet checked on a
physical iOS 26 device, where the reports come from.

One oddity while testing: the very first "Check server" after typing the URL
answered `404 network`; the next tap, unchanged, answered "Connected. API 1,
sign-in: none". Not reproduced; possibly the first tap fired before the typed
URL reached state.

## What the capture phase must change

- **Outbox.** A failed share shows an error and Retry, and only one share is
  tracked at a time (ruling E2). The capture phase needs a persistent outbox
  (`expo-sqlite`) drained on launch and on connectivity, so a share made
  offline or mid-save is never lost.
- **Idempotent save.** `POST /api/v1/save` is not idempotent, so a retry after
  a timeout can create a duplicate note. The outbox needs a client id per
  share that the server dedupes on.
- **Bearer sessions for reads.** The capture token can only save: `notes()`
  with it is 401, and Ask needs a session cookie. The app needs a bearer
  session from sign-in for reads and Ask; the Ask test here only works
  against a no-password server.
- **Extension naming.** The share sheet shows the plugin default "Kothai -
  Share Extension". `iosShareExtensionName` also sets the Xcode target name
  with non-alphanumerics stripped, so plain "Kothai" collides with the main
  target; use something like "Save to Kothai".
- **App group on a real team.** `group.app.kothai.mobile` must be registered
  on an Apple developer team before a device build. The simulator does not
  check.
- **ATS.** Only local networking is allowed over plain http. A self-hosted
  server on a Tailscale IP or LAN name over http will be blocked; decide
  between requiring https and per-domain exceptions.
- **`run:ios` launch quirk.** `npx expo run:ios` builds and installs, then
  exits 1 with "Simulator app did not open fast enough". Launch with
  `npx expo start --dev-client` plus
  `xcrun simctl launch <udid> app.kothai.mobile`. CocoaPods also needs
  `LANG=en_US.UTF-8`.
- **Workspace.** The app is outside the pnpm workspace (ruling E1) and
  installs with npm so `@kothai/api` stays a live symlink; Metro watches only
  `packages/api`. Revisit if the app joins the workspace.

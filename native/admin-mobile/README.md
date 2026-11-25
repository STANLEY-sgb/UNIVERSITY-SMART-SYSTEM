# KIU Admin — mobile wrapper

Capacitor shell around `apps/admin`. It does not bundle the built web assets — `capacitor.config.ts`
points the WebView's `server.url` at the real running admin console (default
`http://192.168.100.179:3000`, override with `KIU_ADMIN_URL`). This is required for the existing
httpOnly/SameSite session cookies to work: a bundled local copy would run on a different origin and
the cookies would silently stop being sent.

`cleartext: true` is for the current plain-HTTP LAN demo phase only — remove it once the admin
console is served over a real HTTPS domain.

## Status

Done: `pnpm install`, `npx cap add android`, manifest permissions, `npx cap sync android`, and a
verified `./android/gradlew assembleDebug` (`BUILD SUCCESSFUL`) producing
`android/app/build/outputs/apk/debug/app-debug.apk`. A local JDK 21 and Android SDK
(`ANDROID_HOME=E:\dev\android-sdk`, platform 36) were already present on this machine.

## Day to day

Make sure `apps/admin` is running in LAN mode (`pnpm --filter @kiu/admin dev:lan`) and the API is
reachable at the same LAN IP, then `npx cap sync android` to pick up a new `server.url` and either
`npx cap open android` (opens Android Studio to run on a device/emulator) or
`./android/gradlew assembleDebug` + `adb install -r android/app/build/outputs/apk/debug/app-debug.apk`
to install the debug build on a connected/USB-debugging phone directly.

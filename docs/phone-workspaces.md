# Phone parallel workspaces

Opt-in deterministic phone mode for Astra (and any model using the existing `phone` tool entry). No model calls, hidden prompts, extra extension, copied login state or installed controller app. Android 14+ with trusted/independent-focus virtual displays is required; vendor compatibility is verified at startup rather than silently downgraded.

## Use

```sh
phone workspace start
phone workspace open a com.miui.calculator
phone workspace open b com.android.deskclock
phone workspace observe a b
phone workspace screenshot a /absolute/new-a.png
phone workspace screenshot b /absolute/new-b.png
# Use the returned node ref AND current snapshot token:
phone workspace click a w42:0.2 SNAPSHOT
phone workspace text a w42:0.3 'search text' SNAPSHOT
phone workspace tap a 200 400 SNAPSHOT
phone workspace swipe b 300 900 300 350 300 SNAPSHOT
phone workspace back a SNAPSHOT
phone workspace close a
phone workspace stop
```

`observe a b` returns independent timestamps, display IDs and snapshots; it is concurrent observation, not an atomic same-instant snapshot across apps. Every action consumes its snapshot and also compares a freshly read UI fingerprint. Snapshot lifetime is 10 seconds. Observe again after every action; do not replay actions after transport timeouts.

Two UI slots are available. Actions within a workspace are serialized in the Android broker; independent workspaces can read and perform node actions concurrently. Complete low-level gestures serialize only around the shared input injector. More tasks should queue, not create more heavy App instances.

## Isolation and safety

- One UiAutomation connection per device. Existing main-screen `phone ui` and the supported lockscreen verifier share its read-only main-display tree while the broker is active. DPAPI credential handling remains in the original phone entry.
- Every content/input command still wakes and verifies unlock; `stop` is cleanup-only and does not read UI or input credentials.
- One package lease per device/user. Opening an already-visible main-screen app is refused. If a leased App appears on another display or a foreign app window enters its workspace, further operations stop.
- Required trusted, own-focus, no-top-focus-stealing and destroy-on-removal flags are hard gates. Unsupported ROMs fail with a reason; no main-screen fallback.
- IME is hidden for virtual displays. Text uses node `ACTION_SET_TEXT` only. No clipboard, global keyboard, Home, camera or microphone automation is exposed. Unsupported text targets require a different user-authorized route.
- Read and action coordinates are display-local. Snapshot node refs are not reusable after an action or UI change.
- Physical-screen use of a *different* App is supported; manually opening the App under automation may move its task. Payment/protected pages and fully opaque node trees are not guaranteed. Screenshots can observe opaque trees; coordinate actions still require a valid UI fingerprint in this first version.
- A virtual display is not an Android VM: apps retain their ordinary user/account data, permissions and shared OS resources. No promises of complete resource isolation or arbitrary concurrency.
- The server listens only on an abstract local socket and verifies peer UID is shell/root. No Android TCP listener or unauthenticated app-accessible controller port. Host access uses an owned loopback ADB forward. No connection or credential data is committed/synchronized.
- Cleanup releases only owned virtual displays and the broker's accessibility connection. It never force-stops unrelated apps or clears global Android logs. Close/stop when the task finishes; the initial version does not auto-destroy an idle workspace.

## Delivery and verification

The existing `.github/workflows/release.yml` has an opt-in `phone_only` workflow-dispatch input. CI compiles `src/phone/*.java` against Android 36, produces a DEX JAR, and records commit/run ID/size/SHA256 in `build.json`. No APK or Android broker is built locally. Put the verified CI artifact in `runtime/android/phone-workspaces/`; `start` verifies it again before and after upload.

Local contracts:

```sh
node --test tests/phone.test.mjs tests/phone-workspaces.test.mjs
```

Device acceptance: two distinct nonzero displays, correct package trees, independent node actions and reads, rejected same-package/third-slot/stale-snapshot operations, no physical-screen package change, main-screen XML readback still working, stop releases both displays. These must be measured on the target device; compile success is not device acceptance.

Architecture references: Android multi-resume and per-display focus documentation; scrcpy virtual-display documentation; ShadowAuto's shell-context/UiAutomation design. This implementation deliberately omits ShadowAuto's model loop, clipboard fallback and force-kill startup behavior.

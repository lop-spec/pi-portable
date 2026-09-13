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

`observe a b` returns independent timestamps, display IDs and snapshots; it is concurrent observation, not an atomic same-instant snapshot across apps. Every action consumes its snapshot and also compares a freshly read UI fingerprint. Snapshot lifetime is 10 seconds. Observe again after every action; do not replay actions after transport timeouts. Launch/page-transition animations can legitimately reject a fresh-looking snapshot: wait for stable observations before deciding on the next action. Continuously changing UI may remain unsupported by this strict first-version guard.

Up to **10 UI slots** are available. `start` creates no displays; each `open` allocates one, `close` releases it, and `stop` releases all owned displays. `observe` accepts 1–10 distinct names. Eleven live workspaces are refused; completed tasks must close their workspace instead of leaving ten unused Apps resident.

Actions within a workspace remain serialized; independent workspaces can read and perform node actions concurrently. Ten read workers, a bounded 20-read queue and 12 request workers support the larger limit without unbounded fanout. A batch has one 15-second deadline, not 15 seconds per App. Complete low-level gestures still serialize only around the shared injector. These are admission limits, not a guarantee that every ten-App workload is fast.

After upgrading, `start` verifies the broker actually reports capacity 10. An old two-slot broker is not silently reused or replaced: finish its tasks, run `stop`, install the matching CI artifact, then `start`. `list.maxWorkspaces` reports the running broker's real limit.

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

Device acceptance: step through 2→4→6→10 distinct nonzero displays, verify correct package trees, independent node actions and reads, rejected same-package/eleventh-slot/stale-snapshot operations, unchanged physical-screen package/focus, working main-screen XML readback, and stop releasing every owned display. These must be measured on the target device; compile success is not device acceptance.

## Verified ten-slot smoke test (2026-09-13)

Device: 2602BRT18C / Android 16 (API 36). Installed broker commit `93e24ccc0021571e6b10d8bbb448dfb26bbf4894`, [successful cloud run](https://github.com/lop-spec/pi-portable/actions/runs/34743707984). JAR: 16119 bytes; SHA256 `c6756592d07cbd7ced4372bef545fad9af2211c97b3c9ab401d5c61ded82dc0c`. The 37 host tests passed in CI and on both managed Windows hosts; source, manifest and JAR were synchronized with backup/hash readback, excluding credentials and live mappings.

The old two-slot broker was detected and left untouched until the user authorized closing its workspaces. After explicit stop/start, the new broker reported `maxWorkspaces: 10` and initially had zero displays.

The final acceptance run used three joint-read samples at each stage:

| Resident Apps | Joint read, host end-to-end | Broker PSS sample |
| --- | --- | --- |
| 2 | 361–368 ms | 99838 KiB |
| 4 | 277–389 ms | 117684 KiB |
| 6 | 243–338 ms | 127293 KiB |
| 10 | 562–665 ms | 147489 KiB (about 144 MiB) |

- Predeclared smoke-test gates: each batch ≤6 seconds, broker PSS ≤512 MiB, available system memory ≥512 MiB, Android thermal status ≤2, and physical-screen focus 0. All stages passed. At ten Apps, available memory was 2592272 KiB (about 2.47 GiB); every sampled thermal status was 0. App process memory is **additional** to broker PSS. These samples do not establish sustained throughput, temperature or battery limits.
- Ten distinct nonzero displays returned package-correct trees: calculator, clock, settings, weather, downloads, Google Translate, calendar, file explorer, Google DocumentsUI and Xiaomi app store. Compass (`com.miui.compass`) and notes (`com.miui.notes`) were rejected with `APP_NOT_ON_TARGET_DISPLAY`; their attempted displays were released, with no main-screen fallback. Compatibility is App-specific, not universal.
- With all ten resident, concurrent calculator text input and clock navigation passed. The eleventh workspace, duplicate-App lease, consumed and cross-workspace snapshot tokens were rejected. This tests ten concurrent reads and two independent actions under ten-App residency, not ten simultaneous gestures.
- The physical-screen App remained unchanged within each run (the launcher in the first run, a browser App in the final run); sampled `mTopFocusedDisplayId` stayed 0, and `phone ui` worked while ten displays were resident. Simultaneous human typing and user-triggered migration of a leased App remain unverified.
- Calculator expression and clock alarm tab were restored. All test displays and the broker were stopped. WindowManager teardown is asynchronous: the first cleanup test checked too early; the corrected test only observed removal, without replaying stop. Final readback found one closing display at 277 ms and no owned displays at 765 ms, within the unchanged requirement to release every test display (an explicit 8-second observation deadline). No runtime input or isolation gate was relaxed.

There is still no automatic thermal controller or idle auto-stop. Close completed workspaces; ten is a tested admission ceiling for this utility-App sample, not ten independent Android systems or a promise for ten heavy Apps.

## Historical two-slot baseline (2026-09-12, local time)

- Device: 2602BRT18C / Android 16 (API 36). Broker CI commit `8792d31ce8d37a3421ae729ffe8c8ee140346052`, [successful cloud run](https://github.com/lop-spec/pi-portable/actions/runs/34376514732). Artifact SHA256: `87cdfb22b1f7bf78c00250317cdab726363c7b8eb78a7c79be0ae3a12d64b3ef`.
- Calculator and clock ran on distinct nonzero displays. Concurrent direct calculator text input and clock stopwatch navigation passed; original calculator expression and alarm tab were restored without changing alarm settings. Two-display screenshots were captured successfully.
- Joint read: 326–492 ms host end-to-end in the measured samples; sequential two-call read: 648 ms. One concurrent text/click pair: 582 ms. These are smoke-test samples, not a sustained throughput or thermal benchmark.
- Display-scoped tap and scroll both changed only the intended App; the physical-screen package remained `com.miui.home`, and `mTopFocusedDisplayId` remained 0 after actions.
- Duplicate-App, main-screen App and third-slot allocation, reused/cross-workspace tokens and tokens older than 10 seconds were rejected. Existing `phone ui` continued working with the broker active and after stop. Stop removed both virtual displays and the owned broker process; the physical display and desktop remained.
- One two-slot resource sample: broker PSS 110299 KiB (about 108 MiB), RSS 188272 KiB; Android thermal status 0. App process memory is additional. This does not establish a sustained memory/thermal limit.
- Host tests: 35 passed on each managed Windows host, including existing unlock protection, transport recovery and rapid shared-directory backup tests. Source/runtime files were synchronized with physical backup and SHA256 readback. Credentials and live connection state were not synchronized.
- Not yet established: every third-party App, a real user typing on the physical screen at the same time, App migration caused by the user reopening a leased App, and sustained memory/thermal limits. The historical measurements above cover only two slots; they are not evidence of ten-slot compatibility. There is no automatic thermal controller.

Architecture references: Android multi-resume and per-display focus documentation; scrcpy virtual-display documentation; ShadowAuto's shell-context/UiAutomation design. This implementation deliberately omits ShadowAuto's model loop, clipboard fallback and force-kill startup behavior.

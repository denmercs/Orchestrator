---
name: visual-parity-check
description: Screenshot a running TV app, count exact pixel colors, and compare them with design (Figma) values. Works for any build technology, so it can compare a React Native TV app with a native rewrite. Use when checking that on-screen colors match design tokens, when verifying a styleguide or theming change on a tvOS simulator or Fire TV, or when planning an end-to-end (E2E) parity test.
---

# Visual parity check

Every claim below carries one label:

- **[verified]** actually run on a device or simulator
- **[from notes]** taken from saved notes, not re-run
- **[from repo]** read from the repo, nothing run
- **[illustrative]** example text, not copied from a run
- **[unverified]** plausible, never tried

Do not upgrade a label unless you ran the step yourself. Update this file when you do.

## Private values

This skill uses placeholders such as `<DEVICE_UDID>`, `<COREDEVICE_ID>`, `<DEVICE_NAME>`, `<BUNDLE_ID>`, `<DEEP_LINK>`, `<DEV_CLIENT_URL>`, `<TICKET>`, `<FIGMA_FILE_KEY>`, `<NODE_ID>`, `<TV_APP_DIR>`, `<E2E_TESTS_DIR>` and `<SHARED_PACKAGE>`. Keep the real ids, bundle ids, deep links and Figma keys in a private file outside the repo (for example `~/.config/visual-parity/<project>.md`) and read them from there. Never write them into this skill, a test, or a commit message.

## 1. Purpose

Compare what is on screen with design values, independent of how the app is built. The check looks only at pixels, so it applies to React Native today and to a native rewrite later.

Three layers, cheapest first:

1. **Token unit tests.** Assert that generated tokens and the styleguide hold the expected hex values. Fast, runs in CI, but cannot see what actually renders.
2. **Pixel checks (this skill).** Screenshot the running app, count exact colors, compare to expected values.
3. **Human or AI review of layout.** Spacing, alignment, and typography are not covered by color counts. Review screenshots side by side with the Figma render.

## 2. Where it runs

| Environment | Capture | Remote keys | Status |
|---|---|---|---|
| tvOS simulator | `xcrun simctl io <DEVICE_UDID> screenshot out.png` (3840x2160 on an Apple TV 4K sim) | Key codes sent to the Simulator app with osascript System Events: arrows 123 left, 124 right, 125 down, 126 up; 36 Return = Select; 53 Escape = Menu. Needs macOS Accessibility permission for the terminal. The sim must be frontmost. | [verified] |
| Physical Apple TV (hands-off) | `pymobiledevice3 developer dvt screenshot` over a native CoreDevice tunnel (3840x2160); launch by deep link with `devicectl` (section 2a) | None (no d-pad; reach screens by deep link) | Capture and launch [verified]; d-pad [unverified] |
| Physical Apple TV (manual) | Xcode Devices window, Take Screenshot (1920x1080) | Human | [verified] that a human is needed; AppleScript could not click it (-1700) |
| Fire TV / Android TV (device) | `adb exec-out screencap -p > out.png` | `adb shell input dpad keyevent KEYCODE_DPAD_*` | [from notes]; none of it was run |
| Android TV emulator in CI | Appium screenshot | Appium | [from repo] (see section 5) |

### Physical Apple TV

- [verified] Xcode `devicectl` lists the device as paired and available, but `xcrun devicectl` has no screenshot command and cannot send remote or d-pad keys. libimobiledevice (`idevicescreenshot`) is not installed.
- [unverified] Appium XCUITest with WebDriverAgent on the real device. `<E2E_TESTS_DIR>/e2e.config.ts` targets `platformName: tvOS` [from repo]. Needs WDA signing and device trust.
- [verified] Xcode, Window > Devices and Simulators > Take Screenshot (1920x1080 PNG to ~/Desktop) works but is manual. AppleScript could not press the button or select the sidebar row (-1700), so a human must click it.
- [unverified] An HDMI capture card.
- [verified] On the Apple TV 4K 3rd gen tested, real-TV colors in the header were identical to the simulator's. That is one device and one screen; keep a tolerance for other screens or HDR.
- If a human can do a GUI or hardware step faster (wake the TV, pick a row in Xcode), offer that option explicitly.

### 2a. Physical Apple TV, hands-off

Device tested: Apple TV 4K 3rd gen `<DEVICE_NAME>`, with CoreDevice id `<COREDEVICE_ID>`, UDID `<DEVICE_UDID>`, and the dev app `<BUNDLE_ID>`. Run from `/tmp`. All steps below are [verified] unless noted.

1. One-time setup: `python3 -m venv /tmp/pmd3 && /tmp/pmd3/bin/pip install pymobiledevice3`. Set `PYTHONWARNINGS=ignore` to silence LibreSSL warnings. The Xcode symbol copy is a further one-time step of several minutes.
2. Tunnel, in the background with output to a log:
   `/tmp/pmd3/bin/pymobiledevice3 remote start-tunnel --native --udid <DEVICE_UDID> --script-mode`
   `--native` piggybacks Apple's CoreDevice tunnel, so no sudo. It prints `<host> <port>` (values change per run). The TV must be awake and Xcode/CoreDevice must show it connected. Save the pid.
3. Metro must answer `http://<mac-lan-ip>:8081/status` with 200. Use the LAN IP (`ipconfig getifaddr en0`), not localhost, because the TV is a separate machine.
4. Launch with a deep link:
   `xcrun devicectl device process launch --device <COREDEVICE_ID> --terminate-existing --payload-url "<DEV_CLIENT_URL>" <BUNDLE_ID>`
   where `<DEV_CLIENT_URL>` is the dev-client link with the Metro URL (`http://<mac-lan-ip>:8081`) percent-encoded in its `url` parameter. The first screen appeared within about a minute.
5. Capture: `pymobiledevice3 developer dvt screenshot --rsd <host> <port> out.png` gives a 3840x2160 PNG (~4-23 MB), exactly 2x the 1920x1080 layout. Took 6 to 20 s.
6. Count exact colors in the header band (top 16% of height) with the Pillow snippet in 3.5. Example result: `#929da3` 1,530 px (inactive tab), `#768993` 0 px (old muted color gone), `#ebedee` 1,778 px (icon rings), `#fdb528` 1,896 px (underline), `#212b30` 1,148,482 px (header bg).
7. Cleanup: stop the tunnel when done (kill the saved pid).

Cost: about 1-2 minutes and a few thousand tokens per repeat if you do not view the image. Reach other screens by deep link (`<DEEP_LINK>` for a dev-controls screen reaches toasts) [from notes, not tried on the real TV]. d-pad input to the real TV is [unverified].

### 2b. px-to-px rule and cadence

- Never resize before measuring. Resampling blends neighbors into colors that are not on screen. Make a downscaled copy (`sips -Z 1000`) only for viewing and keep the original for counting.
- The 4K capture is 2x the layout: scale Figma and simulator coordinates and sizes by 2 (a 4 px bar is 8 px). Colors compare directly.
- Capture a single window with `screencapture -l <window id>`, never the full screen; other apps (chat, mail) may be visible.
- Cadence: the simulator is the routine check (automated, exact). Run the real-TV check when a change touches colors or layout, or before a release, not on every commit.
- Fire TV over adb is the hardware route that needs no tunnel. It needs the stick's IP and ADB debugging, and it is still untested.

### Fire TV notes

- [from notes] Enable ADB debugging, then `adb connect <ip>:5555`. The stick's IP changes between sessions; read it from `adb devices -l`.
- [from notes] Plain `adb shell input keyevent` is keyboard-source and misreads focus on some TV screens. Use `input dpad keyevent`.
- [from notes] After `am force-stop`, a bare MainActivity start lands on the Development Servers sheet. Relaunch with the deep link. A screenshot's file size is a cheap sanity check (loaded grid about 1 MB, dev-server sheet about 57 KB).
- [from notes] The app scales by window width / 1920 on Fire TV. Check capture resolution and sample coordinates per device; do not reuse tvOS coordinates.

## 3. Recipe (tvOS simulator, steps [verified] except where marked)

Run from the worktree. Never print the app's `.env` file.

### 3.1 Prerequisites in a fresh worktree

- Install dependencies for the TV app only, with the frozen lockfile.
- Generated GraphQL types are usually gitignored: run the app's codegen script.
- The TV app loads `<SHARED_PACKAGE>` from `dist/`. After changing shared code, rebuild that package.
- `<TV_APP_DIR>/.env` is gitignored. Symlink it from the main checkout instead of copying.
- Pillow for pixel counting: `pip3 install --user pillow` [illustrative]. The snippet in 3.5 returned correct counts against a real-TV capture.

### 3.2 Start Metro

```
cd <TV_APP_DIR> && EXPO_TV=1 npx expo start
curl -s -o /dev/null -w "%{http_code}" http://localhost:8081/status   # expect 200
```

### 3.3 Relaunch the dev client and connect

```
xcrun simctl terminate <DEVICE_UDID> <BUNDLE_ID>
xcrun simctl openurl <DEVICE_UDID> "<DEV_CLIENT_URL>"
```

Then press Return (key code 36) to accept the tvOS "Open in ...?" prompt, and wait for the bundle.

Key press example, [illustrative] (not copied from a run, not re-tested; the sim must be frontmost):

```
osascript -e 'tell application "System Events" to key code 36'
```

### 3.4 Reach a state with a deep link, not the d-pad

```
xcrun simctl openurl <DEVICE_UDID> "<DEEP_LINK>"
```

Press Return on the Open prompt. In the app this was tested with, the deep link opens a Dev Controls screen with Success, Error, Info and Warning toast buttons. The version label that normally opens it cannot be reached with the d-pad: it sits to the upper right of the icons, and tvOS focus only moves to items that overlap horizontally.

### 3.5 Capture and measure

- Capture right after the action. Toasts disappear within a few seconds; about 1 second after the press worked.
- Count exact-color pixels in the PNG instead of sampling single points. Anti-aliasing and gradients make single points unreliable. Example: count `#ebedee` pixels inside the header icon region.

[illustrative; returns correct counts, but slow on 4K, a Counter over `getdata()` is faster]

```python
from PIL import Image
im = Image.open("out.png").convert("RGB")
def count(rgb, box):          # box = (left, top, right, bottom) in screenshot pixels
    return sum(1 for p in im.crop(box).getdata() if p == rgb)
```

### 3.6 Expected values from Figma

- Use `get_variable_defs` on the node for token values and `get_screenshot` to render the node, then sample the render.
- `get_design_context` replies with a Code Connect prompt, which is not needed for color checks. Prefer variable defs and screenshots.
- Record the expected values in a small JSON file in the repo. Do not call Figma from CI.

### 3.7 Worked example

Header frame, Figma file `<FIGMA_FILE_KEY>`, node `<NODE_ID>` [verified]: header `#212b30`, selected tab `#ffffff`, inactive tab `#929da3`, icon ring `#ebedee` all matched on the simulator.

Toast frame, node `<NODE_ID>` [verified]. Figma accent per type (icon and bar share one color): error `#f5506a`, success `#5ec468`, info `#39b8fd`, warning `#f09a00` (warning is Figma only; no app-side reading was recorded).

| Toast | App icon | App bar | Result |
|---|---|---|---|
| info | `#39b8fd` | `#39b8fd` | match |
| error | `#ffb3bb` | `#aa1018` | mismatch |
| success | `#c2ecc5` | `#38ab42` | mismatch |

Warning app-side colors were not recorded [unverified].

### 3.8 Worked example: a parity fix loop (`<TICKET>`)

The toast mismatches in 3.7 were fixed like this.

1. Expected values: the Figma toast node (`<FIGMA_FILE_KEY>`, `<NODE_ID>`) sets the accent border and icon to success `#5ec468`, info `#39b8fd`, error `#f5506a`, warning `#f09a00` [verified, read via `get_design_context`].
2. Cause: the app used nearest-RGB picks from the old styleguide, and different, lighter keys for the icons [from repo].
3. Search the token files for the Figma hex before inventing anything. The exact design-system tokens already existed in the TV color token file (the 400 steps of green, blue, red and orange) [from repo].
4. Fix: add toast-specific styleguide keys mapped to those tokens. Do not change the meaning of existing keys, because other screens use them [from repo].
5. Gates: unit tests, typecheck and the token generator's `--check` passed [verified]. Looking at the toasts on a TV or simulator had not been done [unverified].
6. Separate line item, not silently changed: border width is 3 px in Figma and 4 in code. Raise it on its own.

Lessons:
- When Figma and the app disagree, search the token files for the Figma hex first; an exact token usually exists.
- Prefer a new purpose-specific key over remapping a shared one.
- Report non-color mismatches as their own items.

The on-device check [unverified]: open `<DEEP_LINK>`, press each toast button, capture about 1 second later, and count exact colors px-to-px against the four hexes (section 3.5).

## 4. Gotchas (all [verified])

- Escape (tvOS Menu) at the app root exits to the tvOS home screen.
- An arrow-key sequence opened the Expo Dev Menu overlay, and the d-pad cannot close it. Relaunch with the deep link instead.
- Send one key at a time and screenshot after each.
- The simulator screenshot is 2x device points; scale sample boxes.
- A TV token set may hold light-mode component and semantic colors while the TV app is dark-only. Take semantic and component colors from the dark set. Foundation colors are mode-independent.
- A session restart can stop the Metro dev server. Re-check `/status`.

## 5. Fit with the existing test setup

[from repo] Source: a read-only repo survey, nothing run.

- The TV and mobile E2E apps use Appium 2, WebdriverIO and Jest.
- The TV E2E suite (`<E2E_TESTS_DIR>`) can run nightly in CI on a tvOS simulator (macos runner) and an Android TV emulator. In the surveyed repo it had one login smoke spec.
- A diagnostics helper in `<E2E_TESTS_DIR>/src/utils/` saved screenshots as CI artifacts. Nothing compared colors anywhere (no pixelmatch, `toHaveScreenshot` or getPixel).
- Tests reached state by UI sign-in with a shared test account. No deep links or test-only dev controls were used.
- Natural home for a helper: `<E2E_TESTS_DIR>/src/utils/`, next to the diagnostics helper, decoding Appium `getScreenshot` PNGs with `pngjs`.
- Obstacles: retina scale, focus and animation timing, live content making screens non-deterministic, real-device color management (so simulator-only is recommended for exact assertions), and tvOS covered only by a login smoke test.
- Effort for a first version over 3 screens: medium.

## 6. Cost

Done by hand with an AI, exploration was the main cost: navigation and focus traps. As a script it is nearly free: simctl or adb capture, pixel counts, and a JSON file of expected values. No LLM, seconds per run.

## 7. Next steps

1. Create the `<E2E_TESTS_DIR>` helper and the JSON of expected values.
2. Start with three screens: home header, toasts through the dev-controls deep link, and the search screen. The toast on-device check in 3.8 is the first thing to run; the toast fix is unverified until then.
3. Decide a stable test state: a deep link route or mock data.
4. Fire TV adb capture is still untried. Change its matrix labels to [verified] only after running it. Physical Apple TV d-pad input is also untried.

# Device notes

**Nothing in this project has run on a real headset yet.** Everything marked "verified" below was verified either in
public documentation (with the source) or in emulation (IWER in headless Chrome). Steam Frame sources re-checked 2026-10-01.

Legend:
- **Confirmed (source):** stated by the linked source.
- **Emulated:** exercised under IWER.
- **Unverified:** assumption or inference.

## Steam Frame (Valve)

**Summary: this page has not run on a Steam Frame.**
- With the stock browser it cannot start an immersive session (no WebXR).
- A community Chromium build does run WebXR there. That is the only known way to test today (recipe below).
- Sources checked on **2026-10-01**. The date in each row is the date of the source.

| Topic | Status | Notes / source (date) |
|---|---|---|
| Hardware | confirmed | Snapdragon 8 Gen 3, 16 GB, SteamOS. Refresh rates 72/80/90/120 Hz, with 144 Hz experimental. Eye-tracked foveated rendering (native). Greyscale passthrough, with an optional colour camera accessory. Released Sep 2026; the exact day differs between sources. [Wikipedia](https://en.wikipedia.org/wiki/Steam_Frame) (edited 2026-09-27) |
| Stock browser | confirmed **no WebXR** | Chromium/Chrome on the desktop side: "There's seemingly no WebXR support yet." [Road to VR review](https://roadtovr.com/valve-steam-frame-review/) (2026-09-16). The page shows "VR not available" and runs the desktop fallback. |
| Chromium upstream | confirmed, **not shipped by default** | [CL 8132979](https://chromium-review.googlesource.com/c/chromium/src/+/8132979) "vr: enable the OpenXR runtime on Linux" merged 2026-09-29. The feature stays **off by default** (`--enable-features=OpenXR`). The sandbox CL 8441736 merged 2026-09-26 (stated in the same review thread). `kOpenXR` is on by default only on Windows (`device/vr/public/cpp/features.cc`, main, 2026-10-01). The device/vr README on main is stale. **Unknown:** which Chrome release first ships it, and when it is enabled by default. |
| Community WebXR build | confirmed by its author, **not tried by us** | [saphid/chromium-webxr-steam-frame](https://github.com/saphid/chromium-webxr-steam-frame) README and technical notes (2026-09-26/27). Chromium 156.0.8071.0 arm64 on SteamOS 0.3.0 with SteamVR 2.17.10. `isSessionSupported('immersive-vr')` is true, and three.js runs at 72 fps. Launch flags: `--enable-features=OpenXR --disable-seccomp-filter-sandbox --password-store=basic` (the second flag **reduces sandbox security**). The README still calls the OpenXR CL "in review"; it has since merged (row above). |
| Haptics in that build | confirmed **missing** (author) | `gamepad.hapticActuators` is empty. Our haptic pulses are no-ops there. Sound clicks (System > Sound) are the feedback. |
| `inputSource.profiles` in that build | confirmed (author, right controller) | `["oculus-touch", "generic-trigger-squeeze-thumbstick"]`, mapping `xr-standard`. The **left** controller was not reported (**unverified**). |
| Controller "hand" in that build | confirmed (author) | Requesting `hand-tracking` shows a permission prompt. After that, the controller exposes a controller-derived 25-joint `inputSource.hand` (SteamVR skeletal input, not a camera-tracked hand). **Bare-hand tracking was not covered (unverified).** |
| Native finger tracking | confirmed (native only) | Capacitive finger sensing through SteamVR Skeletal Input. OpenXR profile `/interaction_profiles/valve/frame_controller_valve` (`XR_VALVE_frame_controller_interaction`). [Steamworks: Steam Frame input](https://partner.steamgames.com/doc/steamhardware/steamframe/input) |
| WebXR input profile for the Frame | confirmed **missing** | The [input-profiles registry](https://github.com/immersive-web/webxr-input-profiles/tree/main/packages/registry/profiles) `valve` folder still has only `valve-index`. Chromium has no `frame_controller_valve` mapping, so the controllers appear as Oculus Touch (row above). |
| Eye tracking / foveation / immersive-ar via WebXR | **not found**, assume absent | Native eye tracking exists (OpenXR / OpenVR). No WebXR exposure was found in the community build's notes. |
| PC route (Frame as a PC VR headset) | pairing confirmed; **WebXR unverified** | A USB-3 adapter plus SteamVR pairing is documented ([Steamworks: Steam Frame setup](https://partner.steamgames.com/doc/steamhardware/steamframe/setup)). That desktop Chrome on Windows reaches it through WebXR/OpenXR is **unverified**. A `--disable-features=XRSandbox` hint was seen only in a search snippet. |
| Developer mode | confirmed | Steam Settings > System > Enable Developer Mode, then Developer > Set User Password (enables SSH/ADB/RDP). [Steamworks: Steam Frame setup](https://partner.steamgames.com/doc/steamhardware/steamframe/setup) |
| HTTPS to a LAN dev server | **nothing found** | WebXR needs a secure context. Use an HTTPS host, or an SSH tunnel so the page is `http://localhost` on the device. |

### How to test on a Steam Frame today (community build; nothing here is tested by us)

Use the deployed HTTPS URL, or a LAN server through an SSH tunnel.

1. **Developer mode:** turn it on and set a user password (row above). This enables SSH.
2. **Build:** on a Linux PC, build the community Chromium with `build/build.sh` from [saphid/chromium-webxr-steam-frame](https://github.com/saphid/chromium-webxr-steam-frame). The author states about 90 GB of disk and hours of build time.
3. **Install:** copy the result to the Frame (`scp`) and run `frame/install.sh` there. Launch it from the Steam library.
4. **Debug:** `chromium-xr --remote-debugging-port=9223` listens on loopback only. Reach it from the PC through `ssh -L 9223:localhost:9223`.
5. **Testing off-head:** the author's `vrcmd` settings keep the compositor running: `power.pauseCompositorOnStandby 0`, `turnOffScreensTimeout 3600`, and `--handlewakeup`.
6. **In the page:**
   1. Open System > Browser and headset. It lists `enabledFeatures`, the reference space, frame rates, foveation, and each input source's profiles, hand and haptics.
   2. Open the finger debug panel (System > Finger debug).
   3. Press **Save diagnostics** and send the JSON back.
   4. If a per-finger channel moves in the live bars, use **Learn L/R**.
7. **Expected, from the author's notes (unverified by us):**
   - Controllers report as `oculus-touch`.
   - Haptics do nothing.
   - With hand tracking allowed, a controller-derived hand drives the fingers through the XRHand path.

### What the page does about it (no Frame-specific code paths)

**Session setup:**
- Every feature is requested as **optional**: `local-floor`, `bounded-floor`, `hand-tracking`, `layers`.
- The reference space falls back: `local-floor` → `bounded-floor` → `local`.
- The runtime page (System > Browser and headset) and the diagnostics JSON show:
  - `enabledFeatures`, the reference space and the blend mode;
  - the frame rates and foveation;
  - for each input source: profiles, hand, gamepad layout and haptic actuators.
  - Source: `src/features.js`.

**Input is handled by capability, not by device name:**
- `inputSource.hand` → hand path. This covers the community build's controller-derived hand.
- A matching table profile with channels → per-finger gamepad path.
- Otherwise trigger/grip/thumb-touch. An `oculus-touch` profile on a Frame takes this path.

**Placeholder table entry:**
- `valve-frame-placeholder` in `src/input/finger_profiles.json` matches guessed profile ids.
- It has **no channels**, so a Frame would use the fallback until someone maps it.

**Haptics:** sent only when an actuator exists, and they can be switched off (System > Haptics). The WebAudio click is independent of haptics.

**Quality:**
- The UA test for standalone browsers (starting preset `medium`) includes `SteamOS`.
- Whether the community build's UA contains it is **unverified**.
- The GPU pattern also accepts Mesa's `FDnnn` renderer names.
- In any case the in-session auto-scaler reacts to the measured frame period.

**Status strings:** the System tab and the debug panel show "Steam Frame: not verified on hardware".

## Meta Quest (Quest Browser)

| Topic | Status | Notes / source |
|---|---|---|
| Hand tracking | confirmed | XRHand with 25 joints; pinch → select. Hand profile `generic-hand` (registry also has `oculus-hand`, `meta-fixed-hand`). [Meta: WebXR hands](https://developers.meta.com/horizon/documentation/web/webxr-hands/) |
| Controller profiles | confirmed in registry | Quest 3: `meta-quest-touch-plus` → `oculus-touch-v3` → `oculus-touch` → `generic-trigger-squeeze-thumbstick`. The exact runtime strings per model are **unverified**. |
| Fixed foveation | confirmed | `XRWebGLLayer.fixedFoveation` 0..1 ([Meta: FFR](https://developers.meta.com/horizon/documentation/web/webxr-ffr/)). We use `renderer.xr.setFoveation()` per quality preset. It is only effective when rendering straight into the eye buffer; the mirror's render targets are not foveated. |
| Frame rate | confirmed API | `supportedFrameRates` / `updateTargetFrameRate()` since Browser 16.4 ([Meta: frame rates](https://developers.meta.com/horizon/documentation/web/webxr-frames/)). We pick the highest rate ≤ 90. |
| `bounded-floor` | historically buggy | A black-screen regression was reported ([forum](https://communityforums.atmeta.com/discussions/dev-quest/meta-quest-browser-shows-a-black-screen-for-some-webxr-apps-in-latest-patch/1224303)). We prefer `local-floor`. |
| Localhost dev | confirmed | `adb reverse tcp:PORT tcp:PORT`, then `http://localhost:PORT` (a secure context); debug in `chrome://inspect/#devices` ([Meta: remote debugging](https://developers.meta.com/horizon/documentation/web/browser-remote-debugging/)). |
| This page on a Quest | **unverified** | Not run on a device. Frame rate, legibility, grip → wrist offset, haptics and hand-tracking noise are all untested. |

## Emulation environment (what "verified in emulation" means)

**Setup:**
- IWER 2.5.0 (Meta, MIT), with `metaQuest3` config and stereo.
- It is installed with `forceInstall: true`, because headless Chrome has a native `navigator.xr`.
- It runs in headless Chrome driven by puppeteer-core (`tools/emulate_shots.mjs`).
- The browser renders with ANGLE / D3D11 on a desktop GPU (NVIDIA RTX 3080 Ti in the last run, see `report.json` `gpu`).

**What IWER provides:**
- IWER draws both eyes side by side into the canvas; `*_eyeL/_eyeR.png` are crops of that.
- Hand poses come from IWER's built-in `default`/`pinch`/`point`, plus `open`/`fist`/`hook` generated by `src/dev/handposes.js`. These are clean synthetic poses without tracking noise.
- The gamepad-finger device is a **fake** `test-finger-controller` with 4 extra analog buttons and 1 axis. It does not represent any real controller.

**Last full run:** `npm run shots`, 38/38 checks passed and 88 screenshots (`build/shots/report.json`).

### Headless performance (NOT representative of any headset)

These are CPU-side milliseconds per frame, measured over 4 s each in headless Chrome on a desktop.
- The loop runs at about 60-80 Hz, set by the headless compositor.
- GPU time is not measured (WebXR offers no GPU timer; the in-VR perf HUD also shows CPU times only).
- A standalone headset's mobile GPU/CPU will be several times slower.
- The numbers only show relative costs.

Draw calls and triangles grew from round 1 (32 calls / 47.7 k) because the scene now has a shadow pass, blob shadows, a sky dome and underwear layers.

| Scenario | frame | IK | mirror | render (submit) | cloth | draw calls | triangles |
|---|---|---|---|---|---|---|---|
| mirror on (medium: stereo 768 px) | 3.12 ms | 0.22 | 1.83 | 0.68 | 0.07 | 116 | 128.8 k |
| mirror off | 1.61 ms | 0.22 | 0.03 | 0.94 | 0.08 | 46 | 49.7 k |
| mirror low (mono 512 px, every 2nd frame) | 2.07 ms | 0.20 | 0.61 | 0.85 | 0.08 | 82 | 89.3 k |

- **Mirror cost:** one extra scene render per eye per frame (stereo), or one mono render every other frame (`low`).
  - On a headset, expect the mirror to roughly double the GPU scene cost when the avatar fills it.
  - That is why the auto-scaler steps the mirror down first.
- **Cloth** runs in a worker; the main-thread cost shown is only applying results.
- **IK alone** (`npm run bench`, node): 0.026 ms and about 4.6 KB of heap per solve. Round 1 measured 0.053-0.092 ms and about 153 KB.

**Presets** (`src/quality.js`; the starting preset is picked from the UA, the GPU string and a short GPU benchmark at load: 8 full-screen passes of a fixed shader into a 512 px target, timed with a pixel read-back, median of 3 runs):

| Preset | framebuffer scale | foveation | mirror | shadows | cloth |
|---|---|---|---|---|---|
| high | 1.0 | 0.3 | stereo 1024, MSAA 4 | 1024 | every frame |
| medium | 0.9 | 0.6 | stereo 768 | 512 | every frame |
| low | 0.8 | 1.0 | mono 512, every 2nd frame | off | every 2nd frame |

**In-session auto-scaler** (Scene > Auto-adjust, on by default):
- It compares the measured frame period with the session's target rate (72/90 Hz).
- **Down** one level after 1.5 s averaging more than 1.12 × the target period.
- **Up** after 10 s under 1.03 ×, with a 4 s cooldown between changes.
- The levels change only what can change while presenting: mirror quality, foveation, shadows, cloth rate.
- The framebuffer scale needs a new session (Scene > Resolution).

**Unverified:**
- whether `medium` holds 72 Hz on a Quest 3 with the mirror on;
- what the auto-scaler settles on there;
- the Steam Frame community build's performance with this page (its author reports 72 fps for a three.js scene, not for this page).

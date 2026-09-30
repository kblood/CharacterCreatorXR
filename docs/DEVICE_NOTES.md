# Device notes

**Nothing in this project has run on a real headset yet.** Everything marked "verified" below was verified either in
public documentation (with the source) or in emulation (IWER in headless Chrome). Research date: 2026-09/10.

Legend:
- **Confirmed (source):** stated by the linked source.
- **Emulated:** exercised under IWER.
- **Unverified:** assumption or inference.

## Steam Frame (Valve)

**Summary: Steam Frame behaviour of this page is completely unverified.** With the stock browser the page cannot even start an immersive session.

| Topic | Status | Notes / source |
|---|---|---|
| Hardware | confirmed | Snapdragon 8 Gen 3, 16 GB, SteamOS (Arch); announced Nov 2025, reviewed Sep 2026. [Wikipedia](https://en.wikipedia.org/wiki/Steam_Frame), [Road to VR review](https://roadtovr.com/valve-steam-frame-review/) |
| Browser | confirmed | Full Chrome/Chromium (Flathub) on the KDE desktop. The review says "There's seemingly no WebXR support yet." ([Road to VR](https://roadtovr.com/valve-steam-frame-review/)) |
| Immersive WebXR in stock Chromium | confirmed **not available** | `navigator.xr` exists, but `isSessionSupported('immersive-vr')` is false ([saphid/chromium-webxr-steam-frame](https://github.com/saphid/chromium-webxr-steam-frame)). Upstream Chromium does not enable OpenXR on Linux ([device/vr README](https://chromium.googlesource.com/chromium/src/+/refs/tags/148.0.7778.96/device/vr/README.md)). This page then shows "VR not available" and runs the desktop fallback. |
| Community WebXR build | exists, unofficial, **not tried** | [saphid/chromium-webxr-steam-frame](https://github.com/saphid/chromium-webxr-steam-frame): arm64 Chromium with in-progress Linux OpenXR CLs, running on the SteamVR OpenXR runtime. It launches with `--enable-features=OpenXR --disable-seccomp-filter-sandbox` (**reduced sandbox security**). The author reports squeeze/button state reaching pages. Trigger, thumbstick, left controller and hand tracking were not reported. |
| Controller finger tracking | confirmed natively | Capacitive finger sensing exposed through SteamVR Skeletal Input. OpenXR interaction profile `/interaction_profiles/valve/frame_controller_valve`. [Steamworks: Steam Frame input](https://partner.steamgames.com/doc/steamhardware/steamframe/input) |
| WebXR input profile | confirmed **missing** | There is no Steam Frame entry in the [WebXR input-profiles registry](https://github.com/immersive-web/webxr-input-profiles/tree/main/packages/registry/profiles), whose `valve` folder has only `valve-index`. There is none in Chromium's [OpenXR interaction profiles](https://chromium.googlesource.com/chromium/src/+/HEAD/device/vr/openxr/openxr_interaction_profiles.cc) either. |
| What `inputSource.profiles` would report | **unverified** | Likely a SteamVR remap onto a profile Chromium knows (`oculus-touch*` or `valve-index`), not "steam-frame". |
| Per-finger values in `gamepad.buttons/axes` | **unverified, unlikely** | Chromium's OpenXR mapping exposes trigger/squeeze/thumbstick/buttons; skeletal finger curls are not a WebXR gamepad concept. |
| Controller-free hand tracking (XRHand) | confirmed **absent** at OS level (review); **unverified** in WebXR | Expect no `inputSource.hand` on the Frame. |
| Eye tracking / foveation via WebXR | **unverified**, assume not | Natively available via OpenXR `XR_EXT_eye_gaze_interaction` / OpenVR ([Steamworks](https://partner.steamgames.com/doc/steamhardware/steamframe/input)). |
| Frame rate, `local-floor`, dev workflow | **unverified** | No `adb reverse` equivalent is documented. Use HTTPS on the LAN (or an SSH tunnel to localhost if SSH is enabled on the device). |

### What the page does about it (no Frame-specific code paths)

**Session setup:**
- Every feature is requested as **optional**: `local-floor`, `bounded-floor`, `hand-tracking`, `layers`.
- The reference space falls back: `local-floor` → `bounded-floor` → `local`.
- `enabledFeatures`, the reference space, frame rates and foveation are shown in the status line and in the diagnostics JSON.

**Input is handled by capability, not by device name:**
- `inputSource.hand` → hand path.
- A matching table profile with channels → per-finger gamepad path.
- Otherwise trigger/grip/thumb-touch.

**Placeholder table entry:**
- `valve-frame-placeholder` in `src/input/finger_profiles.json` matches guessed profile ids.
- It has **no channels**, so a Frame would use the fallback until someone maps it.

**Mapping a real Frame (if a WebXR browser ever runs there):**
1. Open the **finger debug panel**.
2. Look at the live button/axis values.
3. Use **Learn L/R** to map any per-finger channels. The mapping is stored on the headset.
4. **Save diagnostics** and send the JSON back so the shipped table can be updated.

**Status strings:** the UA test for "mobile XR" (default quality `medium`) includes `SteamOS` and `Linux; Android`. The Reset tab and the debug panel show "Steam Frame: not verified on hardware".

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

**Last full run:** `npm run shots` gave **25/25** checks and 57 screenshots.

### Headless performance (NOT representative of any headset)

These are CPU-side milliseconds per frame, measured over 4 s each in headless Chrome on a desktop.
- The loop is capped at about 60 Hz by the headless compositor.
- GPU time is not measured.
- A Quest's mobile GPU/CPU will be several times slower.
- The numbers only show relative costs.

| Scenario | frame | IK | mirror | render (submit) | cloth | draw calls | triangles |
|---|---|---|---|---|---|---|---|
| mirror on (medium: stereo 768 px) | 2.09 ms | 0.23 | 1.20 | 0.51 | 0.05 | 32 | 47.7 k |
| mirror off | 1.00 ms | 0.21 | 0.02 | 0.61 | 0.05 | 30 | 47.7 k |
| mirror low (mono 512 px, every 2nd frame) | 1.35 ms | 0.20 | 0.43 | 0.57 | 0.05 | 32 | 47.7 k |

- **Mirror cost:** one extra scene render per eye per frame (stereo), or one mono render every other frame (`low`).
  - On a headset, expect the mirror to roughly double the GPU scene cost when the avatar fills it.
  - The render target is 768×~1000 per eye on `medium`, 1024 with 4× MSAA on `high`.
- **Cloth** runs in a worker; the main-thread cost shown is only applying results.

**Presets** (`src/main.js`; auto → `medium` on mobile-XR user agents):

| Preset | framebuffer scale | foveation | mirror | shadows |
|---|---|---|---|---|
| high | 1.0 | 0.3 | stereo 1024, MSAA 4 | 1024 |
| medium | 0.9 | 0.6 | stereo 768 | 512 |
| low | 0.8 | 1.0 | mono 512, every 2nd frame | off |

Unverified: that `medium` holds 72 Hz on a Quest 3 with the mirror on. If it does not, `low` or mirror off is the fallback.

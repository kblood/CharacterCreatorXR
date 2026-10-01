# CharacterCreator XR

A WebXR page that turns the CharacterCreator character into your own VR avatar. You get:

- head + hands IK (VRIK-style, own implementation), clip-driven legs and finger tracking;
- a stereo mirror;
- an in-VR wardrobe/body editor.

It is a single page with no bundler, ES modules, and three.js 0.170 loaded via an importmap.

> **Status:** developed and tested in **emulation only** (IWER in headless Chrome, see "Verified vs. not" below).
> **Steam Frame behaviour is unverified on real hardware.** At the time of writing, Steam Frame's stock browser
> does not offer immersive WebXR at all; see `docs/DEVICE_NOTES.md`.

## Run

```sh
npm install              # dev tools only: iwer (emulation) + puppeteer-core (screenshots)
npm run sync             # copies the built CharacterCreator assets + web modules into assets/ and vendor/
npm run serve            # http://localhost:8080/  (--port N or PORT=N to change)
npm test                 # node unit tests (IK, fingers, calibration, UI logic, quality, mirror maths, ...)
npm run bench            # IK time + allocation per solve (node; desktop CPU numbers)
npm run shots            # emulated XR scenarios + screenshots -> build/shots/ (needs Chrome/Edge)
npm run stage            # flat static site -> build/site/  (local only, uploads nothing)
```

### What `npm run sync` does

- `sync` reads the sibling `../CharacterCreator` repo, or `--src <path>` / `$CC_SRC`, and **only reads it**.
- `assets/` and `vendor/` are synced copies. They are git-ignored; never edit them.
- `vendor/cc/SYNCED.json` records what was copied, with sha256 hashes.
- `clothing.json` and `hair.json` are read generically: new catalogue items show up in the UI without code changes.

### Staging

- `npm run stage` writes `index.html`, `src/`, `assets/`, `vendor/`, a replay fixture and `MANIFEST.json` into `build/site/`.
- `src/dev` (emulation) is left out; add it with `--with-dev`.
- Nothing is deployed; copy the folder to any static HTTPS host yourself.

## Headset access

WebXR needs a **secure context**: HTTPS, or `http://localhost`.

**Quest (Browser), USB:**
1. Run `adb reverse tcp:8080 tcp:8080`.
2. Open `http://localhost:8080/` in the headset.
3. Debug via `chrome://inspect/#devices` on the PC.

**Any headset over LAN:** serve the folder (or `build/site/`) over HTTPS with a certificate the headset trusts.

**Steam Frame:**
- Stock Chrome/Chromium on SteamOS reports `immersive-vr` as unsupported, so the page shows "VR not available" and runs in desktop mode.
- A community Chromium build with Linux OpenXR exists (unofficial; it weakens the sandbox); see `docs/DEVICE_NOTES.md`.
- Nothing here has been tried on a Frame.

## Using it

- **Enter VR:** press "Enter VR".
  - A short tutorial explains the controls on the first run.
  - Height is estimated automatically from a few seconds of upright standing.
  - For a precise fit, use **Calibrate (T-pose)**: Calibrate tab or wrist menu. It stores eye height and arm span per user profile (A/B/C).
- **Board:** placed in front-right of you, clear of the mirror. Tabs:
  - Clothes, with thumbnails, recently worn and a colour ring;
  - Body (Body / Face / Breasts; the Breasts page is female only);
  - Hair;
  - Outfits (outfit slots, character slots, JSON export/import, photo);
  - Calibrate;
  - Scene;
  - System.

  Point with the controller ray (trigger = click), pinch with tracked hands, or poke with your index finger. Grab the bar at the top-right (or squeeze on the board) to move it.
- **Wrist menu:** turn the palm of the non-dominant hand toward your face to get Menu / Mirror / Calibrate / Recenter.
- **Recenter:** hold both palms up, hands together in front of you, for 1 s.
- **Desktop fallback** (no headset, or `?desktop=1`):
  - Look: drag with the mouse, or hold shift.
  - Keys:
    - `W`/`A`/`S`/`D`: walk;
    - `C`: crouch;
    - Space: arms up;
    - `F`: reach forward;
    - `1`–`4`: finger poses (open / fist / point / pinch);
    - `T`: third person (drag to orbit, wheel to zoom).
  - Mouse: left click = trigger, right click = grip.
  - The panels take mouse clicks directly.

### URL parameters

`?outfit=tshirt,jeans,shoes|none &hair=<id>|none &sex=male|female &underwear=0 &breast=0 &mirror=0|1 &floor=1
&lang=da|en &desktop=1 &quality=auto|high|medium|low &locomotion=clips|procedural &cloth=0|1 &tutorial=0 &debug=1
&view=third &replay=<fixture.json>`

Dev only:
- `?emulate=quest3|hands|fingers` (IWER);
- `&shot=1` (hides the HUD, fixed quality, deterministic for screenshots).

Settings persist in `localStorage`; URL parameters win for that page load.

## Features at a glance

| Area | What |
|---|---|
| Avatar | CharacterCreator body: binary sex (default male), all sliders including breast morphs + breast physics (female), default underwear per sex with the catalogue's coverage rule, hair, clothing read generically from `clothing.json`, cloth physics (CharacterCreator's worker runtime, including its `drawfix` and garment `layers`), eyes + blinking |
| Calibration | automatic plateau estimator + T-pose flow; per-user profiles; modes morph (height slider) / scale / own (the world is scaled to the avatar's eye height) / off; arm mode match or proportional |
| IK | VRIK-style, allocation-free per frame: body yaw, neck limit, lean (look down, crouch, reach), kneel, sit heuristic, tracked jump, clavicles, continuous elbow poles, hand-body collision with ghost hands, forearm twist, wrist limits, lost-tracking hold/relax; legs from 11 of the 12 CharacterCreator clips (walk/run/walk_back/strafe ×2 while moving, jump/fall in the air, the 4 idles as hips sway; `land` is replaced by re-planting the feet) with foot lock, procedural steps while standing; see `docs/IK.md` |
| Fingers | XRHand (25 joints) with One-Euro smoothing, per-finger limits and spread retargeting; gamepad per-finger table; trigger/grip/thumb fallback; learn wizard; see `docs/HAND_TRACKING.md` |
| First person | own head hidden for the XR cameras only (still in the mirror and the shadow); near plane 1 cm |
| Rendering | per-eye stereo planar mirror (off-axis frustum), optional hand mirror and floor reflection, sky dome, shadow map + blob shadows |
| Quality | presets from UA/GPU + a short GPU benchmark; in-session auto-scaler on the measured frame period (mirror, foveation, shadows, cloth rate); framebuffer scale and foveation in the UI; perf HUD |
| UI | CanvasTexture panels, ray + poke + grab, slider deadzone + release hysteresis, haptics (optional) + WebAudio click, wrist menu, tutorial, DA/EN; see `docs/UI.md` |
| Characters | 3 local slots, JSON export/import (`{kind:'ccxr-character',version:1}`), outfit slots, photo mode (PNG) |
| Robustness | session end/restart, visibility/blur (physics paused), lost head tracking, WebGL context loss (reload), garment disposal on swap, runtime feature page |
| Diagnostics | status line, finger-debug panel, JSON diagnostics, tracking recorder + `?replay=` |

## Verified vs. not

| Item | Status |
|---|---|
| Node unit tests (94) | **verified**: `npm test` green |
| Boot, avatar, IK poses, mirror, UI, fingers, calibration, photo, session restart under an IWER-emulated Quest 3 in headless Chrome | **verified in emulation** (38/38 checks, `build/shots/report.json`) |
| Hand tracking (XRHand) | **emulation only**: IWER poses plus generated open/fist/hook poses |
| Gamepad finger path | **emulation only**: a FAKE `test-finger-controller`, not a real device |
| Real Quest 3 / Quest Browser | **not verified**: no headset was used |
| Steam Frame | **not verified**. The stock browser has no WebXR; a community build is the only route today (see `docs/DEVICE_NOTES.md`, with a test recipe) |
| Frame rate / GPU cost on headsets | **not measured**: headless numbers are desktop and not representative |
| Haptics, sound, legibility, comfort | **not verified** on a device |
| New CharacterCreator garments (dress, jacket/vest, boots) | **not available**: not committed in the CharacterCreator repo at sync time; they appear automatically after a later sync |

## Layout

- **`index.html`**: importmap, HUD.
- **`src/main.js`**: boot, render loop.
- **Scene:**
  - `src/avatar.js`: character, clothing, cloth, eyes, first-person head.
  - `src/mirror.js`: stereo mirror.
  - `src/room.js`.
  - `src/desktop.js`.
- **Core:** `src/settings.js`, `src/i18n.js`, `src/replay.js`.
- **`src/xr/`**: session (features, reference space, frame rate, foveation) and tracking records.
- **`src/ik/`**: pure solver code (`vrik`, `twobone`, `locomotion`, `cliploco`, `bodyvolume`, `fingers`, `filters`, `rigdata`, `calibrate`, `pm`, `qx`), node-tested.
- **`src/render/`**: thumbnails, photo, blob shadow, mirror maths, read-back tone mapping.
- **`src/quality.js`, `src/features.js`, `src/character_io.js`, `src/ghosthands.js`.**
- **`src/input/`**: finger input layer + `finger_profiles.json`.
- **`src/ui/`**: panels, interaction, pure UI logic, sound, board / wrist / hint / HUD / tutorial / debug UI, hand-joint debug.
- **`src/dev/`**: IWER emulation and the scenario driver (loaded only with `?emulate`).
- **`tools/`**: `sync_assets`, `serve`, `emulate_shots`, `stage_site`, `make_fixtures`, `bench_ik`, `browser`.
- **`tests/`**: node tests and fixtures (`rest_heads.json`, `replay_walk.json`, the latter recorded in emulation).

The code in this repository is released under the MIT license (`LICENSE`). See `LICENSE-NOTES.md` for third-party code and asset licences.

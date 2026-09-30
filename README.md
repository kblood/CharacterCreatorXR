# CharacterCreator XR

A WebXR page that turns the CharacterCreator character into your own VR avatar. You get:

- head + hands IK (VRIK-style, own implementation), procedural legs and finger tracking;
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
npm test                 # node unit tests (IK, fingers, calibration, finger input, replay)
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

- **Enter VR:** press "Enter VR" and stand upright looking straight ahead. Height is estimated automatically; press "Calibrate height" on the board or wrist menu to redo it.
- **Board (next to the mirror):** tabs Clothes / Body / Hair / Scene / Reset. Point with the controller ray (trigger = click) or poke with your index finger. Grab the bar at the top-right (or squeeze on the board) to move it.
- **Wrist menu:** turn the palm of the non-dominant hand toward your face to get Menu / Mirror / Calibrate / Finger-debug.
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

`?outfit=tshirt,jeans,shoes|none &hair=<id>|none &sex=male|female &mirror=0|1 &lang=da|en &desktop=1
&quality=auto|high|medium|low &cloth=0|1 &debug=1 &view=third &replay=<fixture.json>`

Dev only:
- `?emulate=quest3|hands|fingers` (IWER);
- `&shot=1` (hides the HUD for screenshots).

Settings persist in `localStorage`; URL parameters win for that page load.

## Features at a glance

| Area | What |
|---|---|
| Avatar | CharacterCreator body; sliders, hair, clothing, cloth physics (worker), eyes + blinking |
| Calibration | height via the body's own height morph, then a small uniform scale; arm mode "match" or "proportional" |
| IK | VRIK-style: body yaw, lean, crouch, kneel, clavicles, two-bone arms (elbow kept out of the torso), forearm twist, wrist limits, procedural stepping; see `docs/IK.md` |
| Fingers | XRHand (25 joints) → avatar fingers with limits; gamepad per-finger table; trigger/grip/thumb fallback; learn wizard; see `docs/HAND_TRACKING.md` |
| First person | own head hidden for the XR cameras only (still shown in the mirror); near plane 1 cm |
| Mirror | per-eye stereo planar reflection (off-axis frustum = oblique clipping), optional hand mirror, frame/room/floor marker |
| UI | CanvasTexture panels, ray + poke + grab, wrist menu, DA/EN; see `docs/UI.md` |
| Diagnostics | status line on the board, finger-debug panel (VR + screen), JSON diagnostics download, tracking recorder + `?replay=` |
| Performance | quality presets (framebuffer scale, foveation, mirror size/MSAA/rate, shadows), target 72–90 Hz |

## Verified vs. not

| Item | Status |
|---|---|
| Node unit tests (37) | **verified**: `npm test` green |
| Boot, avatar, IK, mirror, UI, fingers under IWER-emulated Quest 3 in headless Chrome | **verified in emulation** (25/25 checks, `build/shots/report.json`) |
| Hand tracking (XRHand) | **emulation only**: IWER poses plus generated open/fist poses |
| Gamepad finger path | **emulation only**: a FAKE `test-finger-controller`, not a real device |
| Controller → hand switch (`inputsourceschange`) | **emulation only** |
| Real Quest 3 / Quest Browser | **not verified**: no headset was used |
| Steam Frame (any aspect: WebXR availability, profiles, finger channels, frame rate) | **not verified**, and stock browser has no immersive WebXR (see DEVICE_NOTES) |
| Frame rate / GPU cost on headsets | **not measured**: headless numbers in DEVICE_NOTES are desktop-GPU and not representative |
| Walk/run animation clips as locomotion | **not implemented** (disabled "Clips" option; procedural stepping only) |

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
- **`src/ik/`**: pure solver code (`vrik`, `twobone`, `locomotion`, `fingers`, `rigdata`, `calibrate`, `qx`), node-tested.
- **`src/input/`**: finger input layer + `finger_profiles.json`.
- **`src/ui/`**: panels, interaction, board / wrist / debug UI, hand-joint debug.
- **`src/dev/`**: IWER emulation and the scenario driver (loaded only with `?emulate`).
- **`tools/`**: `sync_assets`, `serve`, `emulate_shots`, `stage_site`, `make_fixtures`, `browser`.
- **`tests/`**: node tests and fixtures (`rest_heads.json`, `replay_walk.json`, the latter recorded in emulation).

See `LICENSE-NOTES.md` for third-party code and asset licences.

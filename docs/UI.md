# In-VR UI

All UI is drawn into canvases shown as textured planes (`CanvasTexture`) on the UI layer (5). There is no DOM overlay in VR. The UI layer is not seen by the mirror or by photos.

- **Board and other panels:** `src/ui/ui.js`.
- **Panel toolkit:** `src/ui/panel.js`. Widgets: button, tab, toggle, slider, swatch, label, thumbnail tile, free-form area.
- **Pure UI logic (tested):** `src/ui/uilogic.js`. Slider drag, colour maths, board placement, recenter gesture.
- **Input:** `src/ui/interact.js`.
- **Click sound:** `src/ui/audio.js`. Synthesized with WebAudio; no audio files.

Texts are Danish/English (`src/i18n.js`), switchable live under System.

## Panels

| Panel | Size | Where | Redraw |
|---|---|---|---|
| **Board** | 1280×900 px, 1.12×0.79 m | placed for the user on the first tracked frame (below) or where they last left it; grabbable; pose saved | on change + 2 Hz for the status line |
| **Wrist menu** | 512×320 px, 0.13×0.08 m | inside of the non-dominant forearm; shown while the **palm faces the eyes** (facing > 0.7, hides < 0.45) within 65 cm; kept upright relative to the viewer. Buttons: Menu (show/hide the board), Mirror, Calibrate, Recenter | on change |
| **Hint** | 768×176 px | 0.9 m in front of the head, follows it smoothly | T-pose countdown/sampling, photo countdown, recenter progress |
| **Perf HUD** | 640×232 px, 0.40 m wide | low left, 0.75 m ahead and 0.5 m below the eyes, tilted toward them, clear of the mirror (Scene > Perf HUD) | 4 Hz: fps, quality level, CPU ms per part (frame, IK, cloth, shadow, mirror, submit), draw calls, triangles |
| **Tutorial** | 960×560 px | at chest height (0.62 m ahead, 0.4 m below the eyes), tilted toward them, so the mirror stays visible; first run only (System > Show tutorial repeats it) | 5 steps, Skip / Next |
| **Finger debug** | 1024×1024 px, 0.6 m | right of the board (VR); bottom-left of the page on desktop | 10 Hz while visible |

**Board placement** (`boardPlacement`):
- The board goes 0.75 m in front-right of the head, 0.3 m below the eyes, facing the user.
- Both board edges are projected from the head onto the mirror plane. If any part of the board would hide the mirror, the board steps out to the side (right first, then left), up to 1.1 m.
- **Recenter** (wrist menu, Calibrate tab, or the gesture: **both palms up, hands together in front, for 1 s**) re-places it for the current head pose.

### Board tabs

- **Clothes:**
  - Slot buttons come from `clothing.json`. A green dot marks a slot with something worn. A slot appears only if it has items for the current sex.
  - An *Underwear on/off* toggle applies the coverage rule.
  - A **thumbnail grid** shows "None" plus every item of the slot.
    - Thumbnails are rendered offscreen, one per frame, from each garment's own GLB in its bind pose, tinted with its primary colour (`src/render/thumbs.js`).
    - They are cached in memory and in `localStorage` (JPEG data URLs, 48 entries LRU). A drawn silhouette shows until a thumbnail is ready.
  - **Recently worn** shows the last 6 items.
  - The colour column applies to the slot's worn garment:
    - a Colour / Colour 2 switch;
    - a 12-colour palette;
    - a **hue ring + saturation/value square** (drag; applied live at about 11 Hz and saved on release).
- **Body:**
  - Pages Body / Face / **Breasts**. The Breasts page appears only when the sex is female; it holds the breast morph sliders, a breast-physics toggle and the physics state.
  - A binary **sex switch** sits on the same row.
  - All CharacterCreator sliders; two columns when there are more than 7.
  - Skin palette.
  - Breast sliders also update the IK torso (hand-body collision bust depth).
- **Hair:**
  - Thumbnail tiles: each style's GLB rendered alone in a 3/4 view.
  - Palette plus hue ring.
- **Outfits:**
  - 3 **outfit slots**: Save here / Wear. They store garments, colours and hair.
  - 3 **character slots** in `localStorage` (`ccxr.characters.v1`): Save here / Load.
  - **Export JSON / Import JSON** with `{ kind: 'ccxr-character', version: 1, … }`. Import validates the file: sliders are clamped to −1..1, unknown ids are dropped with warnings, and only `#rrggbb` colours are accepted (`src/character_io.js`).
  - **Photo:** full body or portrait, from a camera in front of the avatar with the head visible. It is saved as a PNG download and previewed on the board. In VR it waits for a 3 s countdown so you can pose (`src/render/photo.js`). The picture is 960×1200 with a margin above the head and below the feet. The floor marker is hidden for the shot; ghost hands, rays and panels are on the UI layer and never appear in it.
- **Calibrate:**
  - **Calibrate (T-pose):** a 3 s countdown, then 1.5 s of sampling. It measures the eye height (median) and the wrist span when the arms are out. It fails with a reason if tracking is lost or you move more than 8 cm.
  - User profiles A/B/C (several people on one headset).
  - Mode Morph / Scale / **Own scale** / Off, each with a one-line explanation.
  - Arm mode Precise / Proportional.
  - Current values; Reset calibration; Recenter panels.
- **Scene:**
  - Toggles: mirror, hand mirror, floor reflection, cloth physics, ghost hands, body collision, kneel, perf HUD.
  - Wind slider.
  - Locomotion: Clips / Procedural.
  - Sit: Auto / Off.
  - Quality: Auto / High / Medium / Low, plus *Auto-adjust*.
  - Resolution (framebuffer scale, applies at the next VR session).
  - Foveation (live while presenting); *Foveation: automatic* returns it to the quality level's value.
- **System:**
  - Language; dominant hand.
  - Sound, haptics and smooth-hands toggles.
  - Show tutorial; finger debug; hand skeleton.
  - Reset all (a second press within 4 s confirms); move the board back.
  - The Steam Frame "not verified on hardware" warning.
  - **Browser and headset** page: what this browser/session supports (`src/features.js`):
    - secure context, the XR modes, GPU, WebGL and multiview;
    - `enabledFeatures`, reference space, blend mode, frame rates, foveation;
    - every input source with its profiles, hand, gamepad layout and haptics.
- **Footer status line:** mode (XR reference space / desktop / replay), fps, IK ms, and the last toast or calibration result.

## Interaction (`interact.js`)

- **Ray + select:** each controller (or tracked hand, via the browser's pinch-select) casts a ray from its target-ray space.
  - Hover highlights a widget.
  - `selectstart`/`selectend` press and release it. Events are queued per side, so a press shorter than a frame still counts.
  - The ray line shortens to the hit and shows a cursor ring.
  - The non-dominant hand's own wrist menu is skipped for its ray.
- **Poke:** the avatar's index fingertip (the IK result, so it matches what you see) presses a widget when it crosses the panel plane from the front: down at 8 mm, release at 22 mm, active within 7 cm. Poking from behind never presses.
- **Sliders** (`createSliderDrag`):
  - A press on the knob does not jump; dragging is relative to the knob.
  - A 10 px deadzone absorbs pinch jitter.
  - On release, the value from about 90 ms before the release is used. A pinch release drags the ray, and this hysteresis undoes that.
  - A tap on the track jumps there. Changes are throttled while dragging; the final value is sent on release.
- **Grab:** on the board, you can grab by:
  - squeeze;
  - select on the grab bar;
  - select on an empty board area.

  The board then follows the hand rigidly and its pose is saved on release.
- **Feedback:**
  - A haptic pulse on press/grab when `hapticActuators` exist. It can be switched off. It is a no-op on the Steam Frame community build (empty actuators, per its author).
  - An optional WebAudio click (on by default). The audio context is unlocked by the first click / Enter VR.
- **Desktop:** mouse events on the canvas are ray-cast the same way. Capture-phase listeners stop them from reaching the desktop camera/hand simulation. The key help line at the top left follows the UI language and sits on a dark backing. The quality reason shown in Scene/System (e.g. "desktop browser") is translated too.
- **Danish wording** after the visual review:
  - Animation / Procedurel (leg mode);
  - Tøjsæt (tab);
  - Ydelsesmåler (perf HUD);
  - Vis rigtige hænder (ghost hands).

## Persistence

- **Stored in `localStorage`** (`ccxr.settings.v1`, every access guarded):
  - outfit, colours, body sliders, sex, hair, underwear;
  - mirror / floor reflection / cloth / wind;
  - calibration, per user profile;
  - arm mode, dominant hand, language, quality, auto-adjust, framebuffer scale, foveation;
  - board pose;
  - outfit slots, recently worn, tutorial done;
  - sound / haptics / smoothing;
  - learned finger mapping.
- **Separate keys:** character slots (`ccxr.characters.v1`) and thumbnails (`ccxr.thumbs.v1`).
- **URL parameters** override for that load: `?outfit= &hair= &sex= &underwear=0 &breast=0 &mirror= &floor=1 &lang= &desktop=1 &quality= &locomotion= &cloth= &tutorial=0 &debug=1 &view=third &replay=`.
- **Reset all** clears the stored settings.

## Verified in emulation (`npm run shots`, screenshots in `build/shots/`)

- Ray hover + trigger click switches tabs: `ui_hover_*`, `ui_body_tab_*`.
- Ray slider drag changes the body weight 0 → 0.69: `ui_slider_*`.
- The wrist menu appears when the left palm faces the head: `ui_wrist_*`.
- An index-finger poke presses the Hair tab: `ui_poke_*`.
- Desktop mouse clicks switch all seven tabs (Danish): `ui_board_{clothes,body,hair,outfits,calib,scene,system}.png`.
- English + female: `ui_en_female_*.png` (Breasts page, Bra slot, hair grid, outfits, runtime page).
- Thumbnails rendered and cached.
- Character JSON round trip.
- T-pose calibration flow with countdown: `calib_countdown_*`.
- Tutorial + perf HUD + floor reflection: `tutorial_hud_floor_*`.
- Photos: `photo_full.png`, `photo_portrait.png`.

**Not verified:**
- Legibility and comfort in a real headset. Text sizes were chosen for about 1 m viewing distance at Quest resolution.
- Haptics, the poke feel and the click sound on device.
- The recenter gesture with real hand tracking. It is only unit-tested.

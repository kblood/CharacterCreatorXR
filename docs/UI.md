# In-VR UI

All UI is drawn into canvases shown as textured planes (`CanvasTexture`) on the UI layer (5). There is no DOM overlay in VR.

- **Board:** `src/ui/ui.js`.
- **Panel toolkit:** `src/ui/panel.js`.
- **Input:** `src/ui/interact.js`.

Texts are Danish/English (`src/i18n.js`), switchable live.

## Panels

| Panel | Size | Where | Redraw |
|---|---|---|---|
| **Board** | 1024×736 px, 0.92×0.66 m | next to the mirror (right side, facing the user); grabbable; position saved | on change + 2 Hz for the status line |
| **Wrist menu** | 512×320 px, 0.13×0.08 m | inside of the non-dominant forearm; shown while the **palm faces the eyes** (facing > 0.7, hides < 0.45) within 65 cm; kept upright relative to the viewer | on change |
| **Finger debug** | 1024×1024 px, 0.6 m | right of the board (VR); bottom-left of the page on desktop | 10 Hz while visible |

### Board tabs

- **Clothes:** per slot from `clothing.json` (top, bottom, shoes, outerwear, …): "None" plus every item.
  - Colour target selector (which worn item to tint).
  - Primary and secondary palettes.
  - The outfit is saved.
- **Body:** Body / Face pages.
  - Sex switch (female/male).
  - All CharacterCreator sliders; two columns when there are more than 8.
  - Skin palette.
- **Hair:** styles from `hair.json` (and None), plus a colour palette.
- **Scene:**
  - Toggles: mirror, hand mirror, cloth physics, hand-skeleton debug, finger debug, kneel.
  - Wind slider.
  - Calibrate height (with the result shown).
  - Calibration mode Morph/Scale/Off.
  - Arm mode Precise/Proportional.
  - Locomotion: procedural. "Clips" is disabled and marked *not implemented*.
  - Dominant hand.
  - Language DA/EN.
  - Quality Auto/High/Medium/Low (the mirror switches live; shadows, framebuffer scale and foveation apply after a reload / the next VR session).
- **Reset:**
  - Reset all; a second press within 4 s confirms.
  - Reset calibration.
  - Reset board position.
  - The Steam Frame "not verified on hardware" warning.
- **Footer status line:** mode (XR reference space / desktop / replay), fps, IK ms, mirror ms, and the last toast or calibration result.

## Interaction (`interact.js`)

- **Ray + select:** each controller (or tracked hand, via the browser's pinch-select) casts a ray from its target-ray space.
  - Hover highlights a widget.
  - `selectstart`/`selectend` press and release it. Events are queued per side, so a press shorter than a frame still counts.
  - The ray line shortens to the hit and shows a cursor ring.
  - The non-dominant hand's own wrist menu is skipped for its ray.
- **Poke:** the avatar's index fingertip (the IK result, so it matches what you see) presses a widget when it crosses the panel plane from the front: down at 8 mm, release at 22 mm, active within 7 cm. Poking from behind never presses.
- **Sliders:** drag while pressed. Changes are throttled while dragging, with the final value on release.
- **Grab:** on the board, you can grab by:
  - squeeze;
  - select on the grab bar;
  - select on an empty board area.

  The board then follows the hand rigidly and its pose is saved on release.
- **Haptics:** short pulse on press/grab when `hapticActuators` exist (optional; not verified on hardware).
- **Desktop:** mouse events on the canvas are ray-cast the same way. Capture-phase listeners stop them from reaching the desktop camera/hand simulation.

## Persistence

- **Stored in `localStorage`:**
  - outfit, colours, body sliders, sex, hair;
  - mirror / cloth / wind;
  - calibration;
  - arm mode, dominant hand, language, quality;
  - board pose;
  - learned finger mapping.
- **URL parameters** override for that load: `?outfit= &hair= &sex= &mirror= &lang= &desktop=1 &quality= &cloth= &debug=1`.
- **Reset all** clears the stored state.

## Verified in emulation (`npm run shots`, screenshots in `build/shots/`)

- Ray hover + trigger click switches tabs: `ui_hover_*`, `ui_body_tab_*`.
- Ray slider drag changes the body weight 0 → 0.7: `ui_slider_*`.
- The wrist menu appears when the left palm faces the head and is readable: `ui_wrist_*`.
- An index-finger poke presses the Hair tab: `ui_poke_*`.
- Desktop mouse clicks switch all five tabs: `ui_board_{clothes,body,hair,scene,reset}.png`.

Not verified: legibility and comfort in a real headset (text sizes were chosen for about 1 m viewing distance at Quest resolution), haptics, and the poke feel.

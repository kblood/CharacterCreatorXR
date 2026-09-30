# Hands and fingers

**Status:** the finger paths below are verified in **emulation** (IWER hands; a FAKE per-finger controller) and in
node tests. Nothing has run on a real headset. **Steam Frame finger tracking is unverified**: see `docs/DEVICE_NOTES.md`.

## Hand pose (wrist)

All sources end up in one hand frame. The IK uses it as the target of the avatar's hand bone.

- Position: the wrist.
- `+Z` = fingers (wrist → middle knuckle); `+Y` = back of the hand; `X = Y × Z`.

It is computed per source:

- **XRHand:** from the `wrist`, `index-finger-phalanx-proximal`, `middle-finger-phalanx-proximal` and `pinky-finger-phalanx-proximal` joints, using the same construction as the avatar's own hand frame (`rigdata.handFrame`). The two frames agree by construction.
- **Controller:** from the **grip space**. The grip → hand rotation is fixed (`src/xr/tracking.js` `GRIP_TO_HAND`), and the wrist is 8.5 cm behind and 1.8 cm dorsal of the grip origin (`GRIP_WRIST_OFFSET`, same for every controller).
  - **Unverified:** per-device offsets. Real controllers differ by a few cm.

## Finger input layer (`src/input/fingerInput.js`)

Pure module with no WebXR objects; node-tested (`tests/fingers.test.mjs`).

1. **Snapshot.** Each frame, every `XRInputSource` is snapshotted into a plain object: `{handedness, profiles, targetRayMode, hasHand, joints, gamepad: {mapping, buttons[{value, touched, pressed}], axes[]}}`.
2. **Evaluate.** Each hand is evaluated in priority order:

| Path | When | Source |
|---|---|---|
| (a) `hand` | `inputSource.hand` present and all 25 joints posed | XRHand joint positions → per-finger flexion angles (`fingerStateFromJoints`) |
| (b) `controller-finger` | a table profile matches `inputSource.profiles` (+ optional mapping / min button & axis counts) and has a channel for that finger | that gamepad button `value` / `touched` / `pressed` or axis, with `min`/`max`/`invert`/`gamma` |
| (c) `controller` | a gamepad without (b) for that finger | xr-standard: trigger (button 0) → index; squeeze (1) → middle/ring/little; touch of buttons 3–6 (thumbstick, A/B/X/Y, thumbrest) → thumb curl |
| `rest` | no source | relaxed hand |

Mapping is per finger: a profile can map only some fingers, and the rest use path (c).

3. **Smooth.**
   - Per hand, finger states are low-pass filtered: 25 ms for hands, 45 ms for controllers.
   - On a source switch (controller put down → hand tracking, `inputsourceschange`), they blend over 0.25 s.
4. **Limit.** Joint limits are applied in degrees (`src/ik/fingers.js` `LIMITS`):

| | pitch (MCP flex) | yaw (spread, relative to rest) | bend1 (PIP) | bend2 (DIP) |
|---|---|---|---|---|
| index … little | −25 … 95 | −25 … 25 | −5 … 115 | −10 … 95 |
| thumb | −35 … 65 | −55 … 30 | −25 … 80 | −25 … 95 |

### Measuring and applying finger angles

The same measurement is used when reading XRHand joints, when driving the avatar, and in the emulation poses.

- **Measurement:** per finger segment, the angle is measured in the hand frame about the hinge `K = normalize(reject(D × F, segment))`, where D is the back of the hand and F the finger direction.
- **Same hinge everywhere:** using this one hinge avoids the sign flip that a hinge based only on the back-of-hand axis had in a tight fist. That flip was found in emulation: a fist read as 0.26 curl.
- **Mapping to the avatar:** the avatar's fingers are driven by the same angles relative to its own rest pose. The user's finger proportions are not transferred.

## Mapping table (`src/input/finger_profiles.json`)

The shipped entries:

- **`emulated-finger-controller`:** matches the IWER test device `test-finger-controller`, with buttons 7–10 and axis 4. It is **fake**, for testing only.
- **`valve-frame-placeholder`:** matches profile ids starting with `valve-frame`, `valve-steam-frame`, `steam-frame` or `valve-frame-controller`. The **fingers are empty on purpose**: no public WebXR profile or gamepad layout exists, and the ids are guesses.
- **`valve-index`:** the registry profile has no per-finger channels, so it uses the fallback.

The channel spec is `{button: i, field: 'value'|'touched'|'pressed'}` or `{axis: i}`. Optional keys:
- `min`, `max`;
- `invert`;
- `gamma`;
- `touchCurl`: the curl when a channel is only touched.

## On the headset: debug panel + learn wizard

Open the panel with Scene → "Finger debug", the wrist menu, or `?debug=1`. In VR it floats next to the board; on desktop it is also drawn in the page.

**What it shows, per hand:**
- source kind, `inputSource.profiles`, target-ray mode;
- the matched table profile;
- gamepad mapping and button/axis counts;
- a live bar per button (value, plus touched/pressed dots) and per axis;
- per-finger curl, plus the **path** each finger took (e.g. `controller-finger:button8`, `controller:trigger`, `hand`).

**Save diagnostics** downloads a JSON file with:
- UA and features;
- sources;
- the full gamepad snapshots;
- the evaluated paths;
- the mapping table;
- perf.

The same data goes to `localStorage` and the console.

**REC** records the tracking (including gamepad snapshots and joints) and downloads a fixture. Play it back with `?replay=<file>`.

**Learn L / Learn R** walks you through a sequence of poses:
1. open hand;
2. index;
3. middle;
4. ring;
5. little;
6. thumb.

For each pose there is a 3 s get-ready, then 1.2 s of sampling. For each finger, the wizard picks the button value or axis channel that moved most from the "open" baseline and is not already taken. The result is a table profile for the current `inputSource.profiles`. It is stored in `localStorage` and overrides the shipped file (`mergeTables`). "Clear learned mapping" removes it.

This is how per-finger channels on an unknown controller (e.g. Steam Frame, if it ever exposes any in a browser) can be mapped without code changes. **Unverified**: whether any browser exposes such channels at all.

## Emulation coverage (`npm run shots`, `build/shots/report.json`)

- **Hands (IWER, `primaryInputMode = 'hand'`):**
  - poses `default`, `pinch` and `point` are IWER built-ins;
  - `open`, `fist` and `hook` are generated by `src/dev/handposes.js`, which flexes IWER's pose about the same hinges;
  - checks:
    - open ≈ 0;
    - fist ≥ 0.99;
    - point: index 0, middle 0.78;
    - pinch raises the index curl;
    - source kind = `hand`.
- **Gamepad-finger path:**
  - the FAKE `test-finger-controller` drives each finger from its own button/axis;
  - the paths are reported per finger;
  - the debug panel is shown in VR;
  - diagnostics JSON is produced;
  - the learn wizard maps b7–b10 + a4 correctly.
- **Auto-switch:** controller → hand → controller via `inputsourceschange`, checked in both directions.

## Not done / limits

- Hands have no collision with the body or the panels (the index-tip poke is a proximity test, not physics).
- Hand-tracking wrist position is used directly. There is no filtering beyond the finger low-pass, and no "hand lost" prediction beyond the IK's 0.25 s blend to a relaxed arm.
- Thumb opposition from XRHand is approximated by pitch/yaw/bend1/bend2. Thumb-to-finger contact is not enforced, so a pinch can show a small gap.

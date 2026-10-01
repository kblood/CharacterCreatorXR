# 03 - Mapping tracked data onto our avatar (design, 2026-10-01)

Inputs: the `FaceFrame` abstraction from [02_implementation_options.md](02_implementation_options.md) section 2. Sources are tagged
VERIFIED / REPORTED / INFERRED as before; everything in the mapping tables below that is not VERIFIED is **my proposal and must be
checked visually**. All URLs accessed 2026-10-01.

## 1. What our avatar really has (read from the code and the GLB)

Read from `CharacterCreator/output/base_body.glb` (parsed with a throw-away node script), `blender/build_base.py`, `web/eyelife.js`,
`docs/BLENDER_WORKFLOW.md`, `docs/STATUS.md`, `output/base_body.joints.json`.

| Fact | Value |
|---|---|
| Meshes carrying morphs | `base` (Body), `Eyebrows`, `Eyelashes`, `Eyes` (3 primitives: sclera, iris, cornea), `Teeth`, `Tongue`; each has the same **92** targets (hair and garments carry them too) |
| Skeleton | 53 bones; **no face, eye, jaw or tongue bones** (`joints.json` has only `head`, `neck_01` among the head bones). Everything on the face is morph-only. Eyes, teeth, tongue are rigid on `head`. |
| Teeth | **one** mesh, upper and lower row together. A per-vertex morph can still move only the lower row. |
| Count by kind (sums to 92) | 16 macro, **26 face detail**, **2 expression**, **4 look**, 32 corrective, 6 `bdet_breast_*`, 6 `dyn_breast_*` |

Real morph names:

- **Face detail (26), identity sliders, not for animation:**
  `face_nose_width_decr/_incr`, `face_nose_length_*`, `face_nose_height_*`, `face_jaw_width_*`, `face_chin_*`, `face_cheekbones_*`,
  `face_eye_size_*`, `face_eye_spacing_*`, `face_eye_tilt_*`, `face_lips_*`, `face_mouth_width_*`, `face_ear_size_*`, `face_forehead_*`
  (13 bipolar sliders; `lips` = upper+lower lip volume; source targets listed in `FACE_TARGETS` of `build_base.py`).
- **Expression (2):** `blink_left`, `blink_right` = MakeHuman `expression/units/caucasian/eye-left-closure` and `eye-right-closure`
  (upper and lower lid; eyelashes follow).
- **Look (4):** `look_left`, `look_right` (30 deg yaw at weight 1), `look_up`, `look_down` (25 deg pitch at weight 1); rigid eyeball rotations
  about a sphere fit of each sclera, Eyes mesh only; **both eyes share the same four weights** (no per-eye, no vergence).
- Macro (16), corrective `corr_*` (32), `bdet_breast_*` (6), `dyn_breast_*` (6): body only, not relevant here.

Existing runtime (`CharacterCreator/web/eyelife.js`, used by `src/avatar.js` `tick(dt, gaze)`):

| Constant | Value | Consequence for tracked data |
|---|---|---|
| `LOOK.maxYaw` | 24 deg | tracked gaze beyond is clamped (humans reach ~35-45 deg but the 30-deg morph is linear only to ~0.8 weight) |
| `LOOK.maxUp` / `maxDown` | 8 / 18 deg | **upward gaze is limited by the missing lid-raise morph**; fix = add an upper-lid-raise morph (see 3.2) |
| `LOOK.giveUp` | 60 deg | target farther off-axis returns to front |
| `saccadeThreshold` / `saccadeTau` | 1.5 deg / 35 ms | built for *target* gaze, ignores moves under 1.5 deg, so it must be bypassed for real data (real micro-saccades exist already) |
| micro-saccade | 0.5 deg, every 0.6-2.5 s | disable when tracked |
| blink | 2-6 s random, 120-180 ms, 15 % double | disable when tracked eyelids are valid |
| `lidFollowDown` | 0.3 | keep: lid follows downward gaze |
| returns | `{blink_left = blink_right, look_*}` | **left and right blink are identical today**: tracked wink needs per-eye output |

In `src/main.js` the gaze argument is currently `av.tick(dt, null)`; mirror rendering uses the **view** eye positions (`rec.eyes`), which are not gaze.
First-person hides the head by scaling the head bone to 1e-3 for the main render only (`hideHead`), the face parts live on `LAYERS.HEAD` and show in the mirror.

## 2. Eyes

### 2.1 Gaze -> look morphs

Coordinate handling (VERIFIED geometry conventions: WebXR viewer space looks down -Z with +X right; eyelife yaw > 0 = character's left = +X in glTF, pitch > 0 = up):

```text
g = unit gaze vector in viewer/head space, forward = (0,0,-1)
yawUserRight = atan2(g.x, -g.z)           // + = user's right
yaw   = -yawUserRight                     // eyelife convention: + = character's left
pitch =  atan2(g.y, hypot(g.x, g.z))      // + = up
```

No left/right flip for the mirror: the avatar *is* the user's head, and the mirror reflects the real avatar geometry (our mirror is an off-axis
reflection). If the avatar's left eye ends up on the wrong side after a wink test, fix the sign at one place only.

| Step | Rule | Why / value |
|---|---|---|
| Source choice | per-eye vectors if present, else combined `C` for both eyes | Meta per-eye (`XR_FB_eye_tracking_social`), Steam Frame private data per-eye (REPORTED), Steam Link / WebXR gaze: combined |
| Head offset | angle to the head ray is what matters, so convert with the **same head orientation the avatar uses**, not the raw tracker head | avoids a latency mismatch between head IK and gaze |
| Clamp | yaw +-24 deg (existing), down 18 deg, up 8 deg now / 20 deg after the lid-raise morph | keeps the linear-blend error < 0.3 mm (comment in `eyelife.js`) |
| Soft limit | `y = L * tanh(x / L)` near the clamp instead of a hard clip | no sticking at the limit |
| Filter | One-Euro on yaw/pitch (the project already has `ik/filters.js` for poses) with velocity switch: below ~30 deg/s heavy smoothing (cutoff ~1-2 Hz), above ~100 deg/s almost raw (tau 15-25 ms) | I-VT-style; numbers are typical, tune on device (INFERRED) |
| Deadzone | ignore changes < 0.5 deg while fixating | tracker noise; community eye tools do deadzone + One-Euro too (<https://github.com/sasaken1102r/frameeyeosc>, REPORTED) |
| Blink awareness | freeze gaze when eyelid openness < 0.5 and for ~60 ms after reopening | eyelid motion corrupts the gaze estimate; frameeyeosc "holds gaze while eyes are closed" (REPORTED) |
| Lost tracking | if no valid frame for 250 ms, ease back to procedural over 300 ms | |
| Saccade look | no extra micro-saccades when tracked | real data already has them |

### 2.2 Vergence and per-eye gaze

Today both eyes rotate identically (parallel), which looks "dead" at close range (mirror at 1-2 m: the optical path to the image is twice the distance to the glass).

- Needed morphs: **8 per-eye look targets** named after ARKit: `eyeLookInLeft`, `eyeLookOutLeft`, `eyeLookUpLeft`, `eyeLookDownLeft` and the same for Right.
  Built exactly like `look_*` but with the rotation pivot of **one** sclera only (the build already fits a sphere per sclera).
- Keep `look_*` as the combined legacy interface (alias: `look_left` = in/out of both eyes toward character's left).
- With only a combined ray: vergence by an assumed focus distance D (default 1.5 m; in the mirror use 2 x distance to the mirror plane): per eye
  yaw offset = +- atan((ipd/2) / D); ipd ~ 0.063 m (typical; INFERRED), or the avatar's own eye spacing (`face_eye_spacing_*` changes it).
- Per-eye data from the tracker already contains the convergence, use it as is.

### 2.3 Eye contact in the mirror and calibration

- When the user looks at the avatar's eyes in the mirror, tracked gaze direction (in head space) points to the mirror image of the eyes; the avatar's rendered eyes then look at the user's eyes. This needs **the avatar's eye positions to coincide with the headset's eye positions** (offset of 1-2 cm gives < 1 deg at 2 m, fine). The project already positions the head from the eyes (`avatar.js` eye bounding box).
- Optional calibration (INFERRED design): "look at your own eyes in the mirror for 2 s". Compute the expected direction to the mirror image of each eye geometrically, average the tracked gaze, store a per-eye (yaw, pitch) bias in `localStorage`, apply it, and reject it if it exceeds 5 deg. Also offer "recenter".
- The headset's own calibration (Quest: Settings -> Movement tracking -> Eye tracking -> Calibrate, <https://www.meta.com/help/quest/8107387169303764/>, REPORTED) comes first; our bias is only a residual correction.
- "Look at camera" (existing mode) stays for desktop / no-tracking; in XR with valid tracking the mode `auto` picks tracked.

### 2.4 Blink and lids

| Tracked channel | Our morph | Rule |
|---|---|---|
| `eyeBlinkLeft/Right` (FB `EYES_CLOSED_L/R`, VERIFIED names) | `blink_left` / `blink_right` (later aliases `eyeBlinkLeft/Right`) | per-eye, direct, see below |
| `eyeWideLeft/Right` (FB `UPPER_LID_RAISER_L/R`) | new `eyeWideLeft/Right` from MakeHuman `eye-*-opened-up` (exists, name-based; check visually) | also enables higher upward gaze |
| `eyeSquintLeft/Right` (FB `LID_TIGHTENER_L/R`) | new from MakeHuman `eye-*-slit` (exists; check visually) | |
| `cheekSquint*` (FB `CHEEK_RAISER_*`) | none today; mix `eyeSquint` + `mouthSmile` | |

Blink processing: deadzone 0.05; per-user min/max calibration (running 2nd/98th percentile) because trackers rarely reach exactly 0 or 1;
closing is fast (tau ~10 ms), opening slower (tau ~30 ms); never let a blink last under 1 frame (the data can drop a frame at 90 Hz).
Left/right naming must be verified once with a wink test (ARKit/FB "left" is the subject's left; INFERRED, not found stated in the pages read).

### 2.5 Priority and blend rules (procedural, look-at, tracked)

Evaluate per channel group each frame; crossfade 150 ms on changes. This is an interface proposal around the existing `createEyeLife`:

| Situation | Blink | Gaze |
|---|---|---|
| Tracked gaze + tracked eyelids valid | tracked only, procedural blink **off** (else double blinks) | tracked |
| Tracked gaze only (WebXR gaze ray, Steam Link) | procedural blink **on** (no eyelid data) | tracked |
| Tracked eyelids only (face stream without gaze) | tracked | explicit look mode, else procedural idle |
| Nothing valid / stale > 250 ms | procedural | look mode (off/camera/mouse) |
| User forced look mode (desktop UI) | procedural unless blink checkbox off | that mode |

Final eyelid = `max(trackedOrProceduralBlink, lidFollowDown * look_down)`; this keeps the existing downward-gaze lid.
New API sketch: `eyeLife.update(dt, target, tracked)` where `tracked = {gazeL, gazeR, openL, openR, valid}` returns per-eye `blink_left/right`
and per-eye look weights. Pure functions, node-testable exactly like `tests/face.test.mjs`.

## 3. Face

### 3.1 The two vocabularies (both VERIFIED lists)

**Meta `XR_FB_face_tracking2`, 70 weights** (enum order, <https://registry.khronos.org/OpenXR/specs/1.1/man/html/XrFaceExpression2FB.html>);
the first 63 are the `XR_FB_face_tracking` set (count per Meta: 63 / 70 incl. tongue, <https://developers.meta.com/horizon/documentation/unity/move-face-tracking/>):

```text
BROW_LOWERER_L/R, CHEEK_PUFF_L/R, CHEEK_RAISER_L/R, CHEEK_SUCK_L/R, CHIN_RAISER_B/T, DIMPLER_L/R, EYES_CLOSED_L/R,
EYES_LOOK_DOWN_L/R, EYES_LOOK_LEFT_L/R, EYES_LOOK_RIGHT_L/R, EYES_LOOK_UP_L/R, INNER_BROW_RAISER_L/R, JAW_DROP,
JAW_SIDEWAYS_LEFT, JAW_SIDEWAYS_RIGHT, JAW_THRUST, LID_TIGHTENER_L/R, LIP_CORNER_DEPRESSOR_L/R, LIP_CORNER_PULLER_L/R,
LIP_FUNNELER_LB/LT/RB/RT, LIP_PRESSOR_L/R, LIP_PUCKER_L/R, LIP_STRETCHER_L/R, LIP_SUCK_LB/LT/RB/RT, LIP_TIGHTENER_L/R,
LIPS_TOWARD, LOWER_LIP_DEPRESSOR_L/R, MOUTH_LEFT, MOUTH_RIGHT, NOSE_WRINKLER_L/R, OUTER_BROW_RAISER_L/R,
UPPER_LID_RAISER_L/R, UPPER_LIP_RAISER_L/R,                                   (= 63)
TONGUE_TIP_INTERDENTAL, TONGUE_TIP_ALVEOLAR, TONGUE_FRONT_DORSAL_PALATE, TONGUE_MID_DORSAL_PALATE,
TONGUE_BACK_DORSAL_VELAR, TONGUE_OUT, TONGUE_RETREAT                          (= 70)
```

**ARKit 52** (names as in MPFB's `faceservice.py` and used by three.js/MediaPipe; Apple's page itself could not be read, only its title:
<https://developer.apple.com/documentation/arkit/arfaceanchor/blendshapelocation>): browDownLeft/Right, browInnerUp, browOuterUpLeft/Right, cheekPuff,
cheekSquintLeft/Right, eyeBlinkLeft/Right, eyeLookDownLeft/Right, eyeLookInLeft/Right, eyeLookOutLeft/Right, eyeLookUpLeft/Right, eyeSquintLeft/Right,
eyeWideLeft/Right, jawForward, jawLeft, jawOpen, jawRight, mouthClose, mouthDimpleLeft/Right, mouthFrownLeft/Right, mouthFunnel, mouthLeft,
mouthLowerDownLeft/Right, mouthPressLeft/Right, mouthPucker, mouthRight, mouthRollLower, mouthRollUpper, mouthShrugLower, mouthShrugUpper,
mouthSmileLeft/Right, mouthStretchLeft/Right, mouthUpperUpLeft/Right, noseSneerLeft/Right, tongueOut (VERIFIED list; MPFB's code is the source:
MPFB 2.0.17 package read locally; MediaPipe emits "52 blendshapes", <https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker/web_js>).
Meta documents an automatic ARKit mapping in its Unity face retargeter (same Meta page); I did not read Meta's table, so the one below is mine.

### 3.2 FB-70 -> internal ARKit-style channels (my proposed conversion, INFERRED, verify with winks/smiles on device)

| ARKit channel | From FB weights |
|---|---|
| browDownLeft / Right | `BROW_LOWERER_L/R` |
| browInnerUp | max(`INNER_BROW_RAISER_L`, `_R`) |
| browOuterUpLeft / Right | `OUTER_BROW_RAISER_L/R` |
| cheekPuff | max(`CHEEK_PUFF_L`, `_R`) (FB has no single weight) |
| cheekSquintLeft / Right | `CHEEK_RAISER_L/R` |
| eyeBlinkLeft / Right | `EYES_CLOSED_L/R` |
| eyeWideLeft / Right | `UPPER_LID_RAISER_L/R` |
| eyeSquintLeft / Right | `LID_TIGHTENER_L/R` |
| eyeLookUp/Down Left/Right | `EYES_LOOK_UP/DOWN_L/R` |
| eyeLookInLeft, eyeLookOutLeft | `EYES_LOOK_RIGHT_L`, `EYES_LOOK_LEFT_L` (the left eye looking right is "in") |
| eyeLookInRight, eyeLookOutRight | `EYES_LOOK_LEFT_R`, `EYES_LOOK_RIGHT_R` |
| jawOpen | `JAW_DROP` |
| jawForward / jawLeft / jawRight | `JAW_THRUST` / `JAW_SIDEWAYS_LEFT` / `JAW_SIDEWAYS_RIGHT` |
| mouthClose | `LIPS_TOWARD` |
| mouthSmileLeft / Right | `LIP_CORNER_PULLER_L/R` |
| mouthFrownLeft / Right | `LIP_CORNER_DEPRESSOR_L/R` |
| mouthDimpleLeft / Right | `DIMPLER_L/R` |
| mouthStretchLeft / Right | `LIP_STRETCHER_L/R` |
| mouthPressLeft / Right | `LIP_PRESSOR_L/R` |
| mouthPucker | mean(`LIP_PUCKER_L`, `_R`) |
| mouthFunnel | mean of the four `LIP_FUNNELER_*` |
| mouthRollLower / Upper | mean(`LIP_SUCK_LB`, `_RB`) / mean(`LIP_SUCK_LT`, `_RT`) |
| mouthShrugLower / Upper | `CHIN_RAISER_B` / `CHIN_RAISER_T` (approximate) |
| mouthLowerDownLeft / Right | `LOWER_LIP_DEPRESSOR_L/R` |
| mouthUpperUpLeft / Right | `UPPER_LIP_RAISER_L/R` |
| mouthLeft / Right | `MOUTH_LEFT` / `MOUTH_RIGHT` |
| noseSneerLeft / Right | `NOSE_WRINKLER_L/R` |
| tongueOut | `TONGUE_OUT` |
| (no ARKit equivalent) | `LIP_TIGHTENER_L/R`, `CHEEK_SUCK_L/R`, the six other tongue weights: ignore |

MediaPipe and VRCFT already speak (nearly) ARKit names, so for those sources this step is the identity (VRCFT's own names differ slightly, e.g. `MouthClosed`, `JawOpen`; map by table at the bridge).

### 3.3 What we can drive today vs. what is missing

Today's usable morphs: `blink_left/right`, `look_*`. The `face_*` sliders are identity shapes (nose width, jaw width...), changing them per frame would
look wrong (and they interact with the garments' collar clearance), so **none of the 26 detail targets are used for expressions**
(`face_lips_*` and `face_mouth_width_*` could fake a smile/puff but would also change the identity; not recommended).

**Available as CC0 data we can bake with the existing pipeline** (the same loader that already produces `blink_*`): MPFB's `data/targets/expression/units/<caucasian|african|asian>/` has
34 targets per variant (read from the MPFB 2.0.17 package zip kept in the Blender work folder; the repo's LICENSE-NOTES already treats this folder as CC0, and MakeHuman's licence file says its "Targets and modifiers ... Poses and expressions" are CC0,
<https://raw.githubusercontent.com/makehumancommunity/makehuman/master/LICENSE.md>, VERIFIED; code is AGPL, GPL for MPFB itself, so no code copying):

```text
eye-left/right-closure, eye-left/right-opened-up, eye-left/right-slit,
eyebrows-left/right-up, -down, -inner-up, -extern-up,
mouth-open, mouth-compression, mouth-pursing, mouth-protusion, mouth-eversion, mouth-retraction, mouth-upward-retraction,
mouth-corner-puller, mouth-depression, mouth-depression-retraction, mouth-elevation, mouth-parling, mouth-part-later,
nose-left/right-dilatation, nose-left/right-elevation, nose-compression, nose-depression, neck-platysma
```

The names are FACS-flavoured but not self-documenting: **my assignments below are guesses from the names (INFERRED)** and need a contact sheet (Blender headless
render of every unit at weight 1, front and 3/4) before use. The MPFB add-on also contains code that can load ARKit-named face units and the 15 Meta visemes
("visemes02 (Meta/ARKit v2 standard, 15 shapes)") and the 22 Microsoft visemes, but **the target data for those is not in the package I inspected**
(the code looks for an optional separate asset pack; its licence is unknown, so it must not be assumed CC0).

| Our target (name to use) | Source | Status |
|---|---|---|
| `eyeBlinkLeft/Right` | have (`blink_left/right`) | alias |
| `eyeWideLeft/Right` | `eye-*-opened-up` | likely; check |
| `eyeSquintLeft/Right` | `eye-*-slit` | likely; check |
| `browDownLeft/Right` | `eyebrows-*-down` | likely |
| `browInnerUp` | `eyebrows-left-inner-up` + `eyebrows-right-inner-up` in one shape | likely |
| `browOuterUpLeft/Right` | `eyebrows-*-extern-up` | likely |
| `jawOpen` | `mouth-open` | likely; check that teeth/tongue follow (the build fits teeth/tongue per sample; lower teeth must move more than upper) |
| `mouthSmileLeft/Right` | `mouth-corner-puller` (symmetric target) split by x | split needed |
| `mouthFrownLeft/Right` | `mouth-depression` split | guess |
| `mouthPressLeft/Right` | `mouth-compression` split | guess |
| `mouthPucker` | `mouth-pursing` | likely |
| `mouthFunnel` | `mouth-protusion` | guess |
| `mouthStretchLeft/Right` | `mouth-retraction` split | guess |
| `mouthUpperUpLeft/Right` | `mouth-upward-retraction` split | guess |
| `mouthLowerDownLeft/Right` | `mouth-depression-retraction` split | guess |
| `noseSneerLeft/Right` | `nose-*-elevation` or `-dilatation` | guess |
| **missing in the CC0 set** | | |
| `cheekPuff` | none | **generate** (project-original, as `dyn_breast_*` was): radial outward displacement over the cheek region with falloff; region mask from the CC0 `cheek` targets' support |
| `cheekSquint` | none | approximate by `eyeSquint` + smile |
| `jawLeft/Right/Forward` | none | generate: rigid-ish jaw translation weighted by a lower-face mask |
| `mouthClose` | none | generate: lips pulled together; only matters together with `jawOpen` |
| `mouthLeft/Right` | none | generate: lateral shift of the lip region |
| `mouthRollUpper/Lower`, `mouthShrug*`, `mouthDimple*` | none | skip (not worth it) |
| `tongueOut` | none | generate: translate the Tongue mesh forward/down (rigid, Tongue mesh only, like `look_*`) |
| 8 per-eye look morphs | none | generate (see 2.2) |

A generated morph is acceptable in this project: LICENSE-NOTES already records `dyn_breast_*` and `look_*` as "project-original, no external geometry".

**Combination problems:** shape keys add linearly. The notorious ones are `jawOpen` with `mouthSmile`, `mouthPucker`, `mouthFunnel` (lips overshoot or intersect the teeth) and left/right squint with the cheek.
The build already has a corrective mechanism (`corr_A__B`: sample(A and B together) minus neutral minus delta(A) minus delta(B), runtime weight = infA x infB) and MakeHuman can load two targets at once, so extend
`CORRECTIVE_PAIRS` with (jawOpen, mouthSmile), (jawOpen, mouthPucker), (jawOpen, mouthFunnel). Also clamp the mouth group at runtime: `jawOpen + 0.5*mouthStretch <= 1`. Limit the weights of the extremes (the existing look clamps are the model).
Garments near the neck (collar, hood) were checked against every face morph at build time (STATUS.md): re-run that check, because `jawOpen` is a larger move than any existing face target.

### 3.4 Minimal viable set (~20 morphs) vs. full

**MVP (20 shape keys, all head-region and sparse):**

| Group | Morphs |
|---|---|
| Eyes (existing + 2) | `eyeBlinkLeft/Right` (existing `blink_*`), `eyeWideLeft/Right`, existing `look_*` 4 (later 8 per-eye) |
| Brows (5 keys) | `browDownLeft/Right`, `browInnerUp`, `browOuterUpLeft/Right` (5 keys) |
| Mouth (11) | `jawOpen`, `mouthSmileLeft/Right`, `mouthFrownLeft/Right`, `mouthPucker`, `mouthFunnel`, `mouthStretchLeft/Right` (or one `mouthStretch`), `mouthClose` |
| Misc (2-3) | `cheekPuff`, `noseSneerLeft/Right` (optional), `tongueOut` |

This covers: blinks/winks, brow raise/frown/surprise, smile/frown, jaw open + all five vowel shapes via recipes (section 3.5), pucker/kiss, puffed cheeks, tongue out. Visemes are **recipes over these keys, not extra shape keys** (below).

**Full ARKit-52:** add `eyeSquint*`, `cheekSquint*`, `mouthDimple*`, `mouthPress*`, `mouthLowerDown*`, `mouthUpperUp*`, `mouthLeft/Right`, `jawLeft/Right/Forward`, `mouthRoll*`, `mouthShrug*`, `noseSneer*`; about 30 more keys; the last six are expensive to model for little visible gain on a face this size.
Size estimate (INFERRED): deltas touch roughly the head's vertices, sparse int16 accessors, tens of KB per target per mesh; the MVP adds on the order of 1 MB to `base_body.glb` (7.2 MB today); measure after the first bake.

### 3.5 Visemes by recipe (also the lip-sync fallback)

Meta's 15 visemes (names VERIFIED from MPFB's list and Meta's Unity page: sil, PP, FF, TH, DD, kk, CH, SS, nn, RR, aa, E, I, O, U) and VRM 1.0's five vowel expressions `aa, ih, ou, ee, oh`
(<https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_vrm-1.0/expressions.md>, VERIFIED) are expressed as weights over the MVP keys. Starting values (INFERRED, tune by eye):

| Viseme | Recipe |
|---|---|
| aa | jawOpen 0.7 |
| E / ee | jawOpen 0.25, mouthStretch 0.6 |
| I / ih | jawOpen 0.15, mouthStretch 0.4 |
| O / oh | jawOpen 0.4, mouthPucker 0.5 |
| U / ou | jawOpen 0.15, mouthPucker 0.9, mouthFunnel 0.4 |
| PP | mouthClose 1, mouthPress 0.6 |
| FF | mouthClose 0.4, mouthUpperUp 0.3, (needs lower-lip tuck: no key; skip) |
| SS, CH, DD, kk, nn, RR, TH | small jaw + stretch/pucker blends, tongue weights if available |
| sil | all 0 |

Fallback chain: tracked mouth channels valid -> use them; else mic; else mouth closed. Do not mix mic and tracked mouth (double motion).

### 3.6 Lip-sync fallback (no face tracking, optional feature)

| Level | Method | Cost | Notes |
|---|---|---|---|
| 1 | Web Audio `AnalyserNode` RMS to `jawOpen` (attack 20 ms, release 80 ms, noise gate) | 20 lines, no deps | enough to see the avatar "talk"; works everywhere, also Steam Frame |
| 2 | Vowel estimate from spectral centroid / two formant bands to `aa ee oh ou ih` recipes | ~100 lines | plausible for a mirror |
| 3 | wLipSync (MIT) MFCC lip-sync with weights per vowel, <https://github.com/mrxz/wLipSync> (REPORTED) | needs a profile calibrated in Unity's uLipSync; secure context | best quality; a one-time profile for the user's voice; Danish vowels are not a perfect match for a 5-vowel model |

Microphone permission prompt + the same consent text. In VR the avatar's mouth also matters for the user's own voice only in the mirror (nobody else sees it in this single-user app).

### 3.7 Tongue, teeth and the head hiding

- Teeth: one mesh, both rows. A `jawOpen` morph moves the lower-row vertices (pick by a plane/vertex group), the upper row stays. Check teeth stay behind the lips at all weights (the existing tests `tests/assets.test.mjs` check "teeth behind the lips ... at every morph", extend them to the new keys).
- Tongue: rigid mesh on `head`; add `tongueOut` as a Tongue-mesh-only morph; for visemes it can also drop slightly with `jawOpen`.
- No new bones: keep everything morph-driven; `joints.json` needs no entries (the file states face/expression/look morphs have no joint offsets).
- First person: `hideHead` collapses the head bone for the main render only; face morph weights are still needed **only if the mirror (or third person) is visible**. Skip the mapping and `morphTargetInfluences` writes when neither is, but keep consuming the stream so the state is warm.
- Performance trap (VERIFIED from three r170 source, <https://raw.githubusercontent.com/mrdoob/three.js/r170/src/renderers/shaders/ShaderChunk/morphtarget_vertex.glsl.js>): the morph shader loops all `MORPHTARGETS_COUNT` per vertex and skips zero influences; cost is per **vertex x active target x render pass**. `WebGLMorphtargets` imposes no cap on active targets (<https://raw.githubusercontent.com/mrdoob/three.js/r170/src/renderers/webgl/WebGLMorphtargets.js>). Body has ~13 k vertices; 25 active face targets x 3 passes (main + stereo mirror) is a real mobile-GPU cost.
  Mitigation: **split the head into its own mesh/primitive** (3-4 k vertices) that carries only face morphs, keep macro morphs on the body; threshold weights below 0.02 to zero; update influences only when changed.

## 4. Naming and export

| Convention | Rule |
|---|---|
| Internal and GLB names for new morphs | **ARKit camelCase** (`jawOpen`, `eyeBlinkLeft`, `mouthSmileRight` ...). Reason: MediaPipe, three.js examples (`webgl_morphtargets_webcam`), VRCFT mappers, Unity/Unreal tooling and Ready-Player-Me-style avatars already speak it. |
| Existing names | `blink_left/right`, `look_*` stay (`EXPORT.md`: "keep names stable"). Add an alias table in mesh `extras` (like `ccJiggle`), e.g. `ccFace: { version: 1, aliases: { eyeBlinkLeft: "blink_left", ... }, lookRangeDeg: {yaw: 30, pitch: 25}, visemes: {...recipes} }`. A later major version may rename. |
| Meta names | not stored; converted at runtime (3.2). Meta's own Unity retargeter maps ARKit-named shapes via JSON config, so ARKit names also help a Unity export (Meta page above). |
| VRM 1.0 | Expressions are a *binding table* in `VRMC_vrm` (preset names `happy, angry, sad, relaxed, surprised, aa, ih, ou, ee, oh, blink, blinkLeft, blinkRight, lookUp, lookDown, lookLeft, lookRight`; override types `overrideBlink/LookAt/Mouth`; `lookAt` may be bone- or expression-based; VERIFIED spec). Our eye-by-morph design matches VRM's expression-type lookAt. Provide the binding as optional export data later (blinkLeft -> `blink_left`, aa -> recipe, ...) rather than renaming. |
| glTF carrying | morph names in `mesh.extras.targetNames` (`EXPORT.md`), `KHR_mesh_quantization` required in morph mode; extend `dynamicMorphs` (baked mode keeps blink/look only) with a `faceMorphs` option that keeps the MVP keys at weight 0 so a baked character can still be animated by Unity/Godot/Unreal; sparse accessors keep it small. |
| Eye ranges | document yaw 30 / pitch 25 deg at weight 1 so other engines can scale rotations. |

## 5. Summary of work implied for the avatar

1. Pure-JS mapper + filters + eye merge (no assets needed): `src/face/` (new), unit-tested with fixtures.
2. Blender build: contact sheet of the 34 MakeHuman units; bake MVP set (MakeHuman units + generated jaw/cheekPuff/tongue/per-eye look); 3 correctives; split head mesh.
3. Re-run the asset tests (teeth behind lips, garment clearance, size budget) on the new keys.
4. Optional: mic lip-sync levels 1-3; VRM binding export.

# IK: head + hands → full body

This is our own implementation in the spirit of Final IK's VRIK. No code was copied from VRIK, three-vrm or other projects.

The solver is pure JS with no three.js dependency, and it is node-tested.

**Solver:** `src/ik/vrik.js`.

**Helpers:**
- `twobone.js`: analytic two-bone;
- `locomotion.js`: procedural stepping;
- `cliploco.js`: clip-driven legs;
- `bodyvolume.js`: torso/head/thigh volume for collision;
- `fingers.js`;
- `filters.js`: One-Euro;
- `rigdata.js`: rest-pose measurements;
- `calibrate.js`;
- `pm.js`: pooled vector math;
- `qx.js`: quaternion helpers.

## Frames and conventions

- **Character frame:** +X = avatar's left, +Y up, +Z forward, metres.
- **Joint names:** canonical humanoid (VRM names), following CharacterCreator's `vendor/cc/animation/canonical.js`.
- **Bones are rotation only.**
  - The solver outputs local rotations per joint (`result.pose`) plus a root placement (`result.rig = {position, yaw, scale}`).
  - `src/avatar.js` writes the placement to the character's parent object, never to a bone's position.
  - Hips height, crouch and jump all come from the parent placement plus leg rotations.
- **Yaw frame:** the solver works in a frame rotated by the body yaw ψ about world Y and divided by the avatar scale, so all rest-pose lengths apply unchanged.
- **Hand input:** `{pos, quat}` of the **wrist**, with the hand frame +Z = fingers (wrist → middle knuckle), +Y = back of the hand.
  - XRHand gives this directly from joints.
  - Controllers use a per-profile grip → wrist offset (`src/xr/tracking.js`). It can be overridden with `settings.gripOffset`.
- **Allocation:**
  - Temporaries come from a pool (`pm.js`) that is rewound at every solve.
  - The result object is reused.
  - `tests/alloc.test.mjs` and `npm run bench` measure this.

## Pipeline (per frame, `solve(input, dt)`)

1. **Body yaw ψ.**
   - A low-pass of the head yaw (`yawTau` 0.45 s), followed hard beyond `yawMaxTwist` (55°).
   - Hands in front steer it slightly (`handYawWeight`).
2. **Head and neck.**
   - Head joint target = tracked eye position minus the rotated rig eye offset.
   - The neck takes `neckShare` of the head rotation. Beyond `neckMax` (70°) relative to the upper chest, the upper chest turns along, so the head never twists off the body.
3. **Spine bend (lean).** Contributions:
   - looking down past 25°;
   - the head being ahead of the feet;
   - a crouch;
   - **a hand reaching beyond arm length** (forward/sideways, up to `handLeanMax` 28°).

   The bend is spread over hips/spine/chest/upperChest (`leanShares`), with the head-yaw twist spread by `twistShares`. The pelvis height then follows the head: bend more when the pelvis would be too low; a residual of up to `heightSlack` (5 cm) is allowed before the feet leave the floor.
4. **Legs.** There are three modes, blended by speed with hysteresis (`moveOn` 0.32 / `moveOff` 0.16 m/s, scale-free).
   - **Standing: procedural stepping** (`locomotion.js`).
     - Planted feet, steps when a foot is more than 13 cm from its target, on body yaw beyond 35°, or as a settle step.
     - Idle hips sway from the CharacterCreator idle clips (`idleSway`).
   - **Moving: clip legs** (`cliploco.js`).
     - The CharacterCreator `walk`, `run`, `walk_back`, `strafe_left` and `strafe_right` clips are sampled once per body into tables. The tables are rebuilt on `setRig`, so a body change keeps clip proportions.
     - Per frame, a 4-direction blend relative to the body facing (walk → run by speed) is applied with a shared phase advanced by the cycle rate.
     - Only the leg **shape** comes from the clips. The pelvis height is still the tracked one.
     - **Foot lock:** a stance foot's ball is pinned in the world while its contact flag is set. A test measures the slide at < 5 mm over 0.6–4 m/s; the replay gives < 0.05 mm.
   - **Air: jump.**
     - An upward head speed above `jumpVy` (0.9 m/s) while the feet are on the floor starts `jump`, once the head is `jumpAbove` (2 cm) **above** standing height. Standing up quickly from a squat reaches standing height but not above it, so it is not read as a jump (before this check it was; `tests/ik_review.test.mjs`). The smallest hop detected is still about 15 cm of head rise, as before.
     - The CharacterCreator `jump`/`fall` clips shape the legs in the air.
     - Landing is detected when the head is back within 1.2 cm of standing height and no longer rising (or after 1.6 s). Then comes `land` (feet re-planted) and, after 0.25 s, `ground`.
   - **Squat/kneel:**
     - The support point shifts toward under the head (`comShift`).
     - In a deep squat the heels lift (up to 28°).
     - Below `kneelAt` × leg length, the `kneelSide` knee goes to the floor.
   - **Sit (heuristic, `sit: 'auto'`).** All of these must hold for `sitDelay` 1.2 s:
     - the eye height is 60–86 % of standing;
     - the gaze is level;
     - the head has moved **back** by at least 2.5 cm since standing (`sitMaxAhead` −0.025 m). Sitting down onto a seat behind you moves the head back. A squat moves it forward, and a straight-down crouch keeps it in place; neither counts. Before, "not more than 4 cm forward" let a straight-down crouch read as sitting;
     - the hands are not near the floor.

     Then the thighs go forward and the feet stay on the floor (the chair is assumed under the pelvis). It can be switched off in Scene > Sit.
5. **Arms.**
   - **Clavicle:** shrug ≤ 18°, protraction ≤ 14°, retraction ≤ 8°.
   - **Two-bone arm** with an elbow pole that points down/out/back in the chest frame, plus 35 % toward the ulnar side of the tracked hand.
     - The pole is continuous: it is blended, not switched, between "hand in front", "overhead" and "behind the back" regimes, and low-pass filtered (`poleTau`).
     - The test sweeps the hand across the chest, overhead, behind the back and to the hips without an elbow jump.
   - **Hand-body collision** (`bodyvolume.js`):
     - The torso is a stack of horizontal ellipses. They were measured once from the morphed CharacterCreator base mesh (male and female default body) and re-mapped onto any rig between the spine landmarks.
     - The breast sliders add bust depth (`setBody({male, bust})`).
     - There is also a head sphere and thigh capsules.
     - Hand (palm + wrist spheres) and elbow are pushed out to the surface. The pushed distance is reported as `drift`, which drives the **ghost hand**: a translucent hand at the real tracked pose, shown when drift > 3 cm (`src/ghosthands.js`, UI layer, not in the mirror).
   - **Twist:**
     - The forearm takes `forearmTwist` (60 %) of the hand's twist about the forearm axis.
     - The twist is unwrapped frame to frame and never wrapped back, then clamped to ±160°. Past the limit the hand stays at the limit until the user turns back. The unwrapped value is re-seeded when a hand is acquired again.
   - **Wrist:** a swing-twist split of the hand relative to the twisted forearm. The swing is limited (85°); the remaining twist is the clamped value above, never read back from the quaternion. Before, the limit read the twist from the quaternion; once that passed 180° it changed sign, and the hand flipped about 130° in one frame. A continuous roll now changes the hand by at most the roll step (`tests/ik_review.test.mjs`).
   - **Lost tracking:** the hand is held where it was for `holdTime` (0.35 s), then blends to a relaxed hanging arm (`lostBlendTau` 0.25 s). When tracking is regained, it blends back.
   - **Arm modes:**
     - `match` (default): the hand goes exactly where the controller is, clamped at full reach.
     - `proportional`: tracked (and held) hand targets are scaled about the shoulder by `armScale` from calibration. The reach lean measures the scaled target, so a long-armed user does not lean for a reach the avatar can make. The relaxed arm of a lost hand is not scaled.
6. **Fingers.** The finger state (see `docs/HAND_TRACKING.md`) is converted into world deltas for the finger bones after the hand rotation.

## Calibration (`calibrate.js`, Calibrate tab)

1. **Automatic** (on entering VR):
   - A plateau estimator collects eye heights only while the head is upright and still: pitch < 20°, roll < 17°, vertical speed < 0.2 m/s.
   - It takes the median of the samples within 6 cm below the 95th percentile, so crouching, sitting and the odd tip-toe do not count.
   - It reports a confidence. A confident estimate calibrates once per session if no stored calibration exists for the user.
2. **T-pose** (Calibrate button, wrist menu):
   - A 3 s countdown, then 1.5 s of sampling.
   - The eye height is the median. It fails ("you moved too much") if the eye spread exceeds 8 cm, or if tracking is lost.
   - In the frames where `detectTPose` holds (wide, level, centred, wrists 0.1–0.45 m below the eyes), the median wrist span gives `armScale` = avatar wrist span / user wrist span (0.8–1.25).
3. **Height modes:**
   - `morph` (default): moves CharacterCreator's **height slider**. Only a residual outside the slider range becomes a uniform scale.
   - `scale`: uniform scale only.
   - **`own`:** the avatar keeps its size, and the **user's world is scaled** instead.
     - The XR camera sits in a `userRig` group scaled by `worldScale` = avatar eye / user eye.
     - The tracking record is scaled by the same factor before the IK (a copy; the source record is not mutated).
     - You see the world from the avatar's eye height, and the hands stay on the controllers.
   - `off`: no height adaptation.
4. **Per user:**
   - Calibrations are stored per profile (A/B/C) in `localStorage`, with time, eye, span, scale and mode.
   - Switching users applies that user's stored calibration.
5. **Mid-session changes:** any change of the avatar scale or the world scale (calibrate, mode switch, user switch, reset) calls `ik.reset()`. A scale step moves the head and feet in the solver frame within one frame. Without the reset, the velocity filter read it as a jump plus walking (review finding; `tests/ik_review.test.mjs`, and the shots check "calibration step"). In `own` mode the XR hand joints are scaled with the record too, so the hand-debug skeleton stays on the hand.
6. **Known:** `armScale` is computed for the scaled `own` world even when calibrating on the desktop, where the world is not scaled. The stored value is right for the next XR session, but in the desktop preview it is off by the world scale.

Verified in emulation:
- After T-pose calibration at 1.60 m, the avatar eye height was 1.600 m.
- In `own` mode, the camera Y was 1.613 m against an avatar eye of 1.609 m (`report.json`).

## Numbers (headless Chrome, desktop CPU: relative only)

`npm run bench` (`tools/bench_ik.mjs`) solves 3 scenarios (standing, walking, arms across the chest) for 3000 frames each.

| | before (round 1) | after (pooled) |
|---|---|---|
| heap allocated per solve | ~153 KB | ~4.4 KB (mostly V8 boxed doubles; no arrays) |
| time per solve | 0.053–0.092 ms | 0.029–0.044 ms |

Elbow inside the torso, out of 300 frames:

| case | before | after |
|---|---|---|
| hand across the chest | 49 | 0 |
| hand crossing low (at the opposite hip) | 98 | 55 |

The low case is a known limitation: the shoulder → hip line runs through the belly, so a valid elbow is often impossible there.

## Limits and known issues

- **Three-point tracking** cannot know the leg pose, hip rotation or elbow position. Everything below the chest is a plausible guess.
- **Sit:** sitting is a timed heuristic. Sitting on a seat directly under you without moving the head back is not recognised, and a slow squat where the head drifts back can still be read as sitting; Scene > Sit: Off disables it. Lying down and one-leg poses are not recognised.
- **Arms:** `match` mode clamps when the user's reach exceeds the avatar's. `proportional` fixes the reach but moves the hands away from the real controllers.
- **Collision** is against an approximate body. The elbow can still end up in the belly when a hand reaches low across the body (above). Hands do not collide with each other.
- **Kneeling** is one-sided and triggered by pelvis height only.
- **Legs are not left/right symmetric** for mirrored input: a sequential stepper has to pick one foot first (left on a tie, then alternating), and settle steps stop below 3.5 cm. The upper body is exactly symmetric.
- **Twist reference:** with the palm down, the hand is already about 43° into the twist range, so the exact range is asymmetric (about +100…185° one way, −150…−240° the other, depending on the arm pose).
- **Cloth colliders** do not follow the avatar's uniform scale outside the morph range.
- **None of this has been tried with a real headset.** Thresholds (`jumpVy`, sit band, step distances) are tuned on emulated and synthetic motion.

## Tests

- `tests/vrik.test.mjs`: standing, reach, bone lengths, elbows/knees, NaN fuzz, yaw, crouch, procedural walking, scale.
- `tests/ik_arms.test.mjs`:
  - collision push-out and drift;
  - pole stability sweep;
  - forearm twist without a wrap flip;
  - neck limit;
  - reach lean;
  - left/right mirror symmetry;
  - result reuse.
- `tests/ik_legs.test.mjs`:
  - clip tables;
  - clip walking with the foot lock;
  - direction blend;
  - stop/turn;
  - sit vs squat vs forward crouch;
  - jump phases;
  - lost hand hold/relax;
  - body change;
  - foot lock across speeds.
- `tests/ik_review.test.mjs` (regressions from the IK review):
  - calibration step + `reset()`;
  - fast stand-up vs hop;
  - straight-down crouch vs sitting;
  - continuous wrist roll without a pop;
  - `armScale` in the lean and the relaxed arm;
  - `reset()` clears all state.
- `tests/alloc.test.mjs`: < 16 KB per solve, in a child process.
- `tests/calibrate.test.mjs`: modes, arm scale, estimator v2, T-pose detection, calibration flow.
- `tests/twobone.test.mjs`.
- `tests/replay.test.mjs`: a walk recorded in emulation, replayed through the solver.

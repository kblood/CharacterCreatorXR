# IK: head + hands → full body

Own implementation in the spirit of Final IK's VRIK. No code was copied from VRIK, three-vrm or other projects.

The solver is pure JS with no three.js dependency, and it is node-tested:
- **Solver:** `src/ik/vrik.js`.
- **Helpers:**
  - `twobone.js`: analytic two-bone;
  - `locomotion.js`: procedural stepping;
  - `fingers.js`;
  - `rigdata.js`: rest-pose measurements;
  - `calibrate.js`;
  - `qx.js`: quaternion helpers.

## Frames and conventions

- **Character frame:** +X = avatar's left, +Y up, +Z forward, metres.
- **Joint names:** canonical humanoid (VRM names), following CharacterCreator's `vendor/cc/animation/canonical.js`.
- **Bones:** **rotation only**. The solver outputs local rotations per joint (`result.pose`) plus a root placement (`result.rig = {position, yaw, scale}`). `src/avatar.js` writes the placement to the character's parent object (`gltf.scene`), never to a bone's position.
- **Y frame:** the solver works in a frame rotated by the body yaw ψ about world Y and divided by the avatar scale, so all rest-pose lengths apply unchanged.
- **Hand input:** `{pos, quat}` of the **wrist**, with the hand frame +Z = fingers (wrist → middle knuckle), +Y = back of the hand.
  - XRHand gives this directly from joints.
  - Controllers use a per-profile grip → wrist offset (`src/xr/tracking.js`).

## Pipeline (per frame, `solve(input, dt)`)

1. **Body yaw ψ.**
   - The head yaw drives it through a low-pass filter (`yawTau` 0.45 s).
   - It is followed hard beyond `yawMaxTwist` (55°).
   - Hands in front of the body steer it slightly (`handYawWeight`).
2. **Head.**
   - Head joint target = tracked eye position minus the rotated eye offset measured on the rig (`rig.eyeOffset`).
   - The head joint gets the full head rotation.
3. **Spine bend (lean).** There are three contributions:
   - looking down past 25° (`pitchLean*`);
   - the head being ahead of the feet (continuous 6 cm dead zone, `offsetLeanMax`);
   - a crouch (`crouchLean`).

   The lean is spread over hips / spine / chest / upperChest (`leanShares`), with the head yaw twist spread by `twistShares`, then clamped to `minLean` … `maxLean`.
   - Pelvis below `minPelvisY`: bend more (bisection).
   - Pelvis above what straight legs allow: bend less.
   - A residual of up to `heightSlack` (5 cm) lets the avatar head sit slightly low instead of lifting the feet. Beyond that the feet leave the floor (that is: jumping).
4. **Upper body positions:** forward kinematics of the spine from the pelvis.
5. **Legs:**
   - **Stepping (`locomotion.js`):** feet stay planted in the world. A foot steps (arc of 5–10 cm, 0.22–0.4 s) when it is more than `stepThreshold` (13 cm, 8 cm while moving) from its target. Other triggers are body yaw beyond 35°, or a small settle step after 0.45 s of standing still. Step targets are predicted from velocity (0.18 s), and a teleport of more than 1.2 × leg length snaps the feet.
   - **Squat:** the support point shifts toward under the head (`comShift`). Past `hipDrop` 0.3 the heels lift.
   - **Toe-off:** when a planted foot is behind a moving pelvis and the stretched leg cannot reach it, the heel is raised about the ball of the foot (up to 35°) instead of pulling the foot off the floor.
   - **Kneel:** below `kneelAt` × leg length, the `kneelSide` knee (default right) goes to the floor with the shin along the floor and the toes tucked.
   - **Knees:** two-bone with a forward pole (slightly outward); knee interior angle ≥ 30°.
6. **Arms:**
   - **Clavicle:** shrugs with hand elevation (≤ 18°), protracts with forward/across reach (≤ 14°) and retracts when reaching back.
   - **Two-bone arm:** the elbow pole points down/out/back in the chest frame, nudged 35 % toward the ulnar (little-finger) side of the tracked hand. The pole's outward component is clamped to at least 0.15, so it never points across the body. It is also low-pass filtered (`poleTau`).
   - **Torso avoidance:** if the elbow still lands inside an ellipse around the chest/belly (`torsoRX/RZ`), the elbow is swung about the shoulder → wrist axis in 10° steps, both ways, to the nearest outside solution.
   - **Twist:** the forearm takes 50 % of the hand's twist about the forearm axis.
   - **Wrist:** swing relative to the forearm is limited (85° + 30° margin), so broken tracking cannot fold the wrist.
   - **Lost tracking:** blends to a relaxed hanging arm over 0.25 s.
   - **Arm modes:**
     - `match` (default): the hand goes exactly where the controller is. It is clamped at full reach, and `debug.arms[side].clamped` reports it.
     - `proportional`: hand targets are scaled about the shoulder by user arm span / avatar arm span, estimated during calibration.
7. **Fingers:** the finger state (see `docs/HAND_TRACKING.md`) is converted into world deltas for the finger bones after the hand rotation.

## Calibration (`calibrate.js`, UI "Calibrate height")

1. **Eye height.** It is measured from the headset, auto-estimated in XR from a few seconds of upright standing, or measured when the user presses the button.
2. **Height fit.**
   - `morph` mode (default) first moves CharacterCreator's own **height slider**. This is a real body change: proportions, the cloth colliders and the joint sidecar stay consistent.
   - Only when the user is outside the slider's range, the residual becomes a **uniform scale** of the placement object (clamped 0.6–1.6; inside the slider range the scale stays 1).
   - `scale` mode uses only scale; `off` does nothing.
3. **Arms.** If both hands are more than 0.8 m apart when calibrating (T-pose), avatar wrist span / user wrist span gives `armScale` (clamped 0.8–1.25). It is used only in the proportional arm mode.

Verified in emulation: after calibration at 1.60 m the avatar eye height was 1.5999 m (`report.json`).

## Limits and known issues

- **Three-point tracking** cannot know leg pose, hip rotation or elbow position. Everything below the chest is a plausible guess. Sitting, lying and one-leg poses are not recognised.
- **Arms:** "match" mode clamps when the user's reach exceeds the avatar's (short avatar or long arms); the hand then stops short of the controller. Proportional mode fixes the reach but moves the hands away from the real controllers.
- **Torso avoidance** is an ellipse approximation. Hands can still pass through the body because the hands have no body collision.
- **Kneeling** is one-sided and triggered by pelvis height only.
- **Locomotion clips:** walk/run animation clips are **not implemented**. The UI option is disabled; only procedural stepping exists.
- **Allocations:** the solver allocates small arrays per frame (functional vector math). This costs about 0.2 ms per frame in headless Chrome on a desktop CPU; it is not measured on a headset. A pooled rewrite would reduce GC pressure if it shows up on Quest.
- **Cloth colliders** do not follow the avatar's uniform scale. Morph calibration keeps the scale at 1 inside the slider range; very short or tall users (outside it) get a scale, and the cloth then collides slightly off.

## Tests

- **`tests/vrik.test.mjs`:**
  - standing;
  - reach within 1 mm;
  - bone lengths preserved;
  - elbows never inside the torso over 300 random poses, knees forward;
  - 3000-frame NaN fuzz;
  - body yaw;
  - crouch;
  - walking;
  - scaled avatar.
- **`tests/twobone.test.mjs`, `tests/calibrate.test.mjs`.**
- **`tests/replay.test.mjs`:** replays a walk recorded in emulation (`tests/fixtures/replay_walk.json`) through the solver and checks:
  - the pose stays finite;
  - planted feet keep the ball of the foot on the floor;
  - steps are taken;
  - the head is tracked within 1 cm.

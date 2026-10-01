# 04 - Roadmap, test plan, privacy text, budget (2026-10-01)

Plan for implementing eye and face tracking in CharacterCreatorXR. Builds on files 01-03 in this folder. Effort numbers are my estimates
(INFERRED), not measurements. URLs accessed 2026-10-01.

## 1. Milestones

| M | Goal | Deliverables | Hardware | Effort |
|---|---|---|---|---|
| **M0** | Input layer and logic, fully offline | `FaceFrame` type; `src/face/` (new): FB70->ARKit mapper, gaze conversion, One-Euro + saccade-aware filter, eye-source merge (priority table, file 03 sec 2.5), per-eye blink output; synthetic generator; face replay format + player; `?face=off|synthetic|replay:<file>` ; node unit tests; consent/status UI strings | none | 2-3 d |
| **M1** | Visible result on desktop and in the mirror without a headset | Blender: contact sheet of the 34 MakeHuman expression units, bake the MVP morphs (file 03 sec 3.4) + per-eye look + 3 correctives + split head mesh; `ccFace` extras; webcam source (MediaPipe) `?face=webcam`; mic lip-sync level 1-2 `?mouth=mic`; emulated-XR screenshots of expressions in the mirror | webcam, mic | 5-7 d (the Blender part dominates) |
| **M2** | Real data from a Quest Pro | Probe page + adapter for a WebXR `gaze` source if it exists; **PC bridge** (`tools/face_bridge.mjs`, OSC->WebSocket) + `?face=bridge`; recorder button -> face fixture; first real fixtures committed (small, anonymous numbers only) | Quest Pro, PC, Steam Link | 3-4 d |
| **M3** | Steam Frame | gaze via Steam Link OSC (combined, mirrored) first; optional per-eye via the community on-device tool through the same bridge; keep mic mouth; document what actually arrived | Steam Frame, PC | 2-3 d (plus waiting on a WebXR-capable browser, see DEVICE_NOTES) |
| **M4** | Polish and export | calibration (eyes, blink range), consent UI da/en, quality tuning, VRM `expressions` binding export, `faceMorphs` export option, docs | all | 3-4 d |

Gate after M2: if the probe shows Quest Browser delivers a real gaze ray, add "standalone Quest" as a supported eye source; otherwise the Quest Pro face route is
"PC headset via Steam Link + desktop Chrome" only (file 02 sec 4.2).

## 2. Tests that need no hardware

### 2.1 What the emulator can and cannot do

Read from the installed IWER 2.5.0 package (MIT, Meta) and its docs; nothing in the project was modified.

| Capability | Finding | Tag |
|---|---|---|
| Gaze input source | Yes. `XRGazeInput` creates an `XRInputSource` with `targetRayMode: 'gaze'`, profile `eye-gaze`, no gamepad, **no select events**, pose relative to the viewer. Enabled when the device config lists `gaze-tracking` or `eye-tracking` (the Meta Quest 3 config does) and the session enables one of them. | VERIFIED, local source |
| Driving it | The remote-control interface has a `'gaze'` device id (orientation only; "Gaze position is derived from the headset"). A type definition mentions `setGazeMode?('off'|'cursor'|'head-locked')`; I found **no implementation of it in the JS**, so do not rely on it. | VERIFIED, local source |
| Face / expression data | **No.** No `expression`, `face` or `XRFace` anywhere in the package. | VERIFIED (grep of the package) |
| Docs | The IWER landing page and README do not mention eye or face. | REPORTED via fetcher: <https://meta-quest.github.io/immersive-web-emulation-runtime/>, <https://github.com/meta-quest/immersive-web-emulation-runtime> |
| Consequence | Eye path via WebXR can be smoke-tested end to end under IWER (does the page request the features, read the `gaze` source, move the eyes). **Face tests must use replay/synthetic fixtures**, injected through our own `FaceFrame` layer, not through WebXR. | |

### 2.2 Acceptance tests (node, `npm test` style; thresholds are proposals)

| ID | Test | Pass criterion |
|---|---|---|
| T0.1 | FB70 -> ARKit mapping golden: set each of the 70 inputs to 1 alone | outputs equal the table in file 03 3.2; exactly 10 inputs unmapped (`LIP_TIGHTENER_L/R`, `CHEEK_SUCK_L/R`, 6 tongue weights other than `TONGUE_OUT`) |
| T0.2 | Gaze conversion quadrants: vectors at (+-20 deg yaw, +-10 deg pitch) | yaw/pitch signs per the eyelife convention; `look_left` > 0 only for character's left |
| T0.3 | Wink: `EYES_CLOSED_L = 1`, `_R = 0` | `blink_left = 1`, `blink_right = 0`; sign flip is one constant |
| T0.4 | Priority matrix (file 03 2.5), 5 scenarios x 10 s at 90 Hz | tracked eyelids valid -> **0** procedural blinks started; tracked gaze only -> procedural blink rate within 2-6 s mean; stale > 250 ms -> procedural back within 300 ms; crossfade <= 150 ms |
| T0.5 | Filter step response, 20 deg saccade at 300 deg/s | output reaches 90 % within 40 ms |
| T0.6 | Filter fixation noise, sigma = 0.3 deg | output sigma < 0.1 deg; no drift (mean error < 0.05 deg) |
| T0.7 | Gaze frozen during blink | with openness < 0.5 the gaze output stays within 0.2 deg of its pre-blink value |
| T0.8 | Clamp and soft limit | output never exceeds 24 deg yaw / 18 deg down / configured up; monotonic |
| T0.9 | Replay determinism | same fixture + same seed -> identical weight hash across runs; looped playback has no jump at the seam > 0.05 |
| T0.10 | Dropped/NaN frames | NaN or missing channel -> previous value held then procedural, never NaN in `morphTargetInfluences` |
| T0.11 | CPU micro-benchmark | mapping + filtering + merge for 70 channels: < 0.05 ms/frame desktop (about 10x margin for a mobile CPU, INFERRED) |

### 2.3 Asset tests (extend `CharacterCreator/tests/assets.test.mjs`)

| ID | Test | Pass criterion |
|---|---|---|
| A1 | Morph names | every MVP name present on Body/Eyes/Teeth/Tongue/Eyebrows/Eyelashes as designed; aliases in `ccFace` resolve |
| A2 | Teeth behind lips, eyes behind brow at every new key at weight 1 and at corrective corners | same tolerance as the existing check |
| A3 | Garment clearance at `jawOpen = 1` | existing collar / hood clearance limits hold |
| A4 | Size budget | `base_body.glb` growth within an agreed limit (estimate about +1 MB; decide before baking) |
| A5 | Head split | Body+Head vertex count equals the old Body; macro morph results identical (max deviation < 0.001 mm like the re-import test) |

### 2.4 Emulated-XR screenshot scenarios (`npm run shots` style)

Per expression fixture (neutral, blink, wink left/right, smile, frown, surprise (brows+jaw+wide), pucker, jaw open, cheek puff, look left/right/up/down, converge):
render the mirror at "eyes", "mouth" and "face" camera presets and compare against stored reference images with a perceptual tolerance, plus asserts:
no console errors, no NaN, mirror still renders both eyes, the head-hidden first-person view shows no face parts (existing check).

### 2.5 Performance test without hardware

Headless numbers are only relative (DEVICE_NOTES). Measure the **delta** with and without 25 active face morphs (frame ms, mirror on/off). Pass: CPU delta < 0.3 ms; no growth in draw calls. GPU cost must be measured on a headset (section 3).

## 3. On-device tests

### 3.1 Quest Pro

| ID | Test | Pass criterion |
|---|---|---|
| Q1 | **Gaze probe** (file 01 sec 4): log `enabledFeatures`, input sources | recorded in a note: gaze source present yes/no, differs from head ray yes/no |
| Q2 | If gaze exists: look at 9 marked points in the mirror | mean angular error < 5 deg after the headset's own calibration; ray not equal to the head ray |
| Q3 | Eye contact: stare at the avatar's eyes in the mirror from 1 m | avatar's rendered pupils point at the viewer's eyes within ~3 deg (visual check with a screenshot) |
| Q4 | Bridge: Quest Pro via Steam Link, desktop Chrome, bridge running | face weights arrive at >= 30 Hz, jaw/smile/brow/blink visibly follow, stale detection triggers within 250 ms when Steam Link OSC is switched off |
| Q5 | Wink/smile sign test | left wink closes the avatar's left eye (the one on the left in the mirror image) |
| Q6 | Frame rate with mirror + tracking | >= 72 Hz sustained for 2 min on the PC route; on standalone, record with the app's diagnostics JSON |
| Q7 | Fixture recording | 10 s recording replays on desktop and looks the same |

### 3.2 Steam Frame

Remember (DEVICE_NOTES): no immersive WebXR in the stock browser; everything starts with a WebXR-capable route.

| ID | Test | Pass criterion |
|---|---|---|
| S1 | Via Steam Link to the PC: enable SteamVR OSC for eye data; capture UDP | note exact address format and whether eyes are mirrored (REPORTED: both eyes identical, eyelid 0) |
| S2 | Gaze drive | combined gaze moves both eyes; blink stays procedural (no eyelid data) |
| S3 | Optional: community on-device tool | per-eye + eyelid arrive; record SteamOS build number and tool version; **expect breakage after updates** |
| S4 | Mouth | mic path works (no face tracking hardware) |
| S5 | Frame rate | as Q6 |

## 4. Privacy, consent, and UI text

Facts to respect:
- Quest Pro eye tracking is **off by default** and has a per-app permission; images never leave the headset and apps get only numbers (<https://www.meta.com/help/quest/8107387169303764/>, Danish locale page, VERIFIED).
- Meta treats expression data as user data under its Developer Data Use Policy: privacy policy and explicit consent (<https://developers.meta.com/horizon/documentation/unity/move-face-tracking/>, VERIFIED).
- The WebXR expression-tracking draft requires explicit consent and anonymised/rounded data (<https://immersive-web.github.io/webxr-face-tracking-1/>, VERIFIED draft).
- GDPR: facial data used for **unique identification** is "biometric data" under Art. 9 (<https://edpb.europa.eu/news/national-news/2023/decision-austrian-sa-against-clearview-ai-infringements-articles-5-6-9-27_hr>, REPORTED; that decision is about recognition). Whether 52 expression weights count is a legal question I did not research; this app stores and sends nothing, which avoids the issue in practice. Not legal advice.

Design rules:
1. Off until the user switches it on in the app, even when the headset has the feature on.
2. Process locally; no network call carries tracking data. The only transport is the user's own bridge to `localhost`.
3. Never stored. Recording is an explicit button, writes a file the user downloads, shows a red "recording" indicator.
4. Status line shows the active source (`tracking: headset gaze / bridge / camera / mic / off`) and a one-tap off.
5. Self-host MediaPipe wasm and model; the camera/mic stream never leaves the page.
6. Fixtures committed to the repo contain only numbers from the developer's own face.

Suggested texts (short, shown before enabling; review wording yourself):

| Where | English | Dansk |
|---|---|---|
| Consent, eyes/face | "Eye and face tracking: your avatar can copy your gaze, blinks and facial expressions in the mirror. Only numbers are used, not pictures. They are processed on this device, are not stored and are not sent anywhere. You can turn it off at any time." | "Øje- og ansigtssporing: din avatar kan kopiere dit blik, dine blink og dine ansigtsudtryk i spejlet. Der bruges kun tal, ikke billeder. De behandles på denne enhed, gemmes ikke og sendes ikke videre. Du kan slå det fra når som helst." |
| Bridge | "Tracking data comes from a program on your own computer (localhost). Nothing leaves your computer." | "Sporingsdata kommer fra et program på din egen computer (localhost). Intet forlader din computer." |
| Camera | "The camera image is analysed in this browser tab only. It is not saved or uploaded." | "Kamerabilledet analyseres kun i denne browserfane. Det gemmes eller uploades ikke." |
| Microphone | "The microphone is used only to move the avatar's mouth. Sound is not recorded." | "Mikrofonen bruges kun til at bevæge avatarens mund. Lyd optages ikke." |
| Recording | "Recording saves numbers (eye and face movement) to a file on this device when you stop. Nothing is uploaded." | "Optagelse gemmer tal (øje- og ansigtsbevægelser) i en fil på denne enhed, når du stopper. Intet uploades." |
| Headset off | "Eye tracking is off in the headset. Turn it on in Settings > Movement tracking > Eye tracking." | "Øjesporing er slået fra i headsettet. Slå den til i Indstillinger > Bevægelsessporing > Øjesporing." (menu names may differ in the Danish UI, check on the device) |

## 5. Performance budget

Budget at 72-90 Hz: 11-14 ms/frame total; the existing app target is DEVICE_NOTES' presets. All figures here are **targets (INFERRED)**.

| Item | Budget | Notes |
|---|---|---|
| Mapping + filter + merge (70 -> ~25 weights) | CPU <= 0.1 ms | trivial arithmetic |
| Writing `morphTargetInfluences` (6 meshes x ~25) | CPU <= 0.05 ms | write only changed values; names resolved to indices once (avoid `Object.entries` per frame as in `applyMorphWeights`: precompute index lists) |
| Bridge/WebSocket parse | CPU <= 0.1 ms | one `JSON.parse` of ~1 KB per message, or binary |
| Vertex shader morph cost | GPU <= 0.5 ms for the head | three r170 loops all targets per vertex and skips zeros (VERIFIED, file 03 3.7); cost = vertices x active targets x passes. 13 k body vertices x 25 targets x 3 passes is too large; **split the head mesh** (3-4 k vertices) first |
| Active targets | <= 25 per frame; threshold < 0.02 -> 0 | |
| Skip rule | no mapping/morph writes when neither the mirror nor third person is visible | first person hides the head |
| Memory | +1 MB GLB (estimate), morph texture grows with targets x vertices | measure `renderer.info.memory.textures` before/after |

The avatar has 92 targets now; the Body mesh's morph texture holds all 92 even though most weights are zero, so the per-frame loop over 92 entries (uniform compare) already exists; adding ~25 targets raises the array and texture, not the number of active ones.

## 6. Risks and unknowns

| Risk | Impact | Mitigation |
|---|---|---|
| Quest Browser exposes no gaze/eye to pages | no standalone Quest eye tracking | probe first (Q1); PC route; procedural fallback is already good |
| No browser exposes face tracking | face only via bridge | design for bridge; keep an `expression-tracking` adapter stub; watch the immersive-web repo |
| MakeHuman expression units look wrong or asymmetric after left/right split | extra Blender work | contact sheet first; generate missing ones; accept a smaller MVP |
| Combination artefacts (smile + open mouth) | ugly mouths | 3 correctives + runtime clamps |
| Steam Frame private data format changes | tool breaks | treat as optional experiment; Steam Link gaze as baseline |
| Steam Frame has no WebXR browser | cannot test in-headset | PC route via Steam Link + desktop Chrome (REPORTED supported); see DEVICE_NOTES |
| Left/right naming mismatch between sources | mirrored expressions | wink test in the checklist; one sign constant per source |
| Latency of streamed data | lips behind own voice | mic path for mouth when streaming; only eyes/face from the bridge |
| Meta/Valve/Chromium policy or API changes | unknown | re-run the probe every few months; record versions in the diagnostics JSON |
| Legal/consent expectations | trust | local-only, off by default, plain texts (section 4) |

## 7. Short checklist: what the user should try or enable first

**Quest Pro (do these before any code)**
1. Update Horizon OS and the Browser (release notes list Browser 150.x as of 2026-08).
2. Settings -> Movement tracking: turn on **Eye tracking**, run **Calibrate eye tracking**; turn on **Natural facial expressions** (face tracking). Names per <https://docs.vrcft.io/docs/hardware/vr/meta/quest-pro> (VERIFIED) and the Meta help page; labels may differ slightly in the Danish UI.
3. Check Settings -> Privacy and Security -> App permissions that eye tracking is allowed for the browser (per-app toggle; the browser may not appear in the list, that itself is useful to know).
4. Open the probe page via `adb reverse` as in the README, press Enter VR, and note the log (file 01 sec 4). Also try `chrome://flags` in the Quest Browser and note whether any entry mentions eye, gaze, face or expression, plus "WebXR Experiments".
5. For the face route: install Steam Link on the Quest Pro, start SteamVR on the PC, open SteamVR settings (Advanced settings = Show) -> Steam Link, enable OSC and "Share eye tracking data ..." / "Share face tracking data ..." (<https://wiki.resonite.com/Face_and_Eye_Tracking_(Setup)>, REPORTED), and note the port.

**Steam Frame**
1. SteamVR on the PC with Steam Link to the Frame; same OSC settings as above; note the OSC port and whether eyes are identical (REPORTED limitation).
2. Make sure eye tracking works at all in SteamOS settings (Valve uses it for foveated streaming; there may be no user toggle: unknown).
3. Developer Mode (Settings -> System) only if you want to try the on-device community tool; it needs an SSH password and is unofficial.
4. Tell me which browser and WebXR route you use on the Frame (stock Chrome has none, DEVICE_NOTES).

**General**
- Have a webcam and a microphone ready for the desktop paths (M1).
- Decide how much extra GLB size is acceptable (estimate +1 MB).

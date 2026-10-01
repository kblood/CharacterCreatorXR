# 02 - Implementation options: getting eye and face data into the web app (2026-10-01)

Builds on [01_webxr_eye_and_face_tracking_status.md](01_webxr_eye_and_face_tracking_status.md) (status and sources). All URLs
accessed 2026-10-01. Tags: VERIFIED / REPORTED / INFERRED as in file 01. Code skeletons use only API that exists
(standard WebXR, MediaPipe Tasks, Node core) or are labelled **DRAFT** or **our design**.

## 1. Ranking by practicality today

| Rank | Option | Gives | Hardware needed | Verdict |
|---|---|---|---|---|
| 1 | **Input abstraction + replay fixtures + synthetic generator** (d) | everything, offline | none | Do first. Everything else plugs into it. |
| 2 | **Webcam face landmarks with MediaPipe** (c) | 52 ARKit weights + head pose, desktop only | webcam | Cheap, makes the mirror alive on desktop today. Good test source. |
| 3 | **Mic-driven mouth** (lip-sync fallback, file 03) | jaw/viseme only | mic | Works on every headset, including the Frame. |
| 4 | **Gaze probe via WebXR** (a) | maybe one combined gaze ray | Quest Pro | 5 minutes to learn if it works. Do on day 1 of hardware. |
| 5 | **PC bridge: OSC/UDP -> WebSocket** (b) | Quest Pro eyes+face; Steam Frame eyes | PC + Steam Link/ALVR/VD | The only route to real face data. More moving parts. Changes the dev flow (desktop Chrome via SteamVR). |
| 6 | **On-headset bridge on Steam Frame** (b2) | per-eye gaze + eyelids | Frame in Developer Mode | Fragile (private format), eyes only, needs a WebXR-capable browser first. Experiment only. |
| 7 | **Native prototype** (Unity/Meta XR Core SDK) | ground-truth recording | Quest Pro + Unity | Only if we need clean ground-truth fixtures. |
| - | `expression-tracking` WebXR API | would be ideal | - | Proposal only; do **not** build on it. Keep a stub adapter. |

## 2. Common design: one input layer, many sources

Our design, not an external API. The avatar code never knows where data came from.

```text
FaceFrame {
  t: seconds (source clock, converted to performance.now()),
  source: 'webxr-gaze' | 'bridge-osc' | 'mediapipe' | 'replay' | 'synthetic' | 'mic',
  gaze:  { L:[x,y,z]|null, R:[x,y,z]|null, C:[x,y,z]|null },   // unit vectors in HEAD space (+Y up, -Z forward, three.js/WebXR)
  eyeOpen: { L:0..1|null, R:0..1|null },                        // 1 = open
  weights: { [channelName]: 0..1 },                             // any subset; names from the ARKit-52 / FB-70 vocabulary
  headPose: [16 floats]|null,                                   // MediaPipe only
  valid: boolean, confidence: number|null
}
```

Rules:
- Every source may supply any subset. The mapper (file 03) treats missing channels as "use procedural".
- A staleness timer (e.g. 250 ms without a frame) flips back to procedural blink/look. VRChat's own OSC eye input does the
  same after 10 s without data (<https://docs.vrchat.com/docs/osc-eye-tracking>, VERIFIED), ours should be much faster.
- Names: use the **ARKit-52 camelCase names** as the internal vocabulary (MediaPipe emits them natively, VRCFT and Meta tools
  map to them). Meta's 63/70 weights are converted by a table (file 03).

## 3. (a) Pure WebXR

### 3.1 Gaze input source (probe first)

Uses standard WebXR calls only. The feature strings `gaze-tracking` / `eye-tracking` come from Meta's emulator source (IWER 2.5.0,
local `node_modules`, VERIFIED as emulator behaviour, **UNVERIFIED as real browser behaviour**), see file 01 section 3.3.

```js
// Request: optional only (an unknown optional feature is expected to be ignored; never put these in requiredFeatures)
const session = await navigator.xr.requestSession('immersive-vr', {
  optionalFeatures: ['local-floor', 'hand-tracking', 'gaze-tracking', 'eye-tracking'],
});
console.log('enabledFeatures', session.enabledFeatures);          // standard attribute in the spec

session.addEventListener('inputsourceschange', e => {
  for (const s of e.added) console.log('source', s.targetRayMode, s.handedness, [...s.profiles]);
});

// per frame
function onXRFrame(t, frame) {
  const viewer = frame.getViewerPose(refSpace);
  for (const s of session.inputSources) {
    if (s.targetRayMode !== 'gaze') continue;
    const p = frame.getPose(s.targetRaySpace, refSpace);        // gaze ray in the reference space
    if (!p || !viewer) continue;
    // head-relative direction: rotate the ray's -Z by inverse(head orientation)
    // (use three.js Quaternion: q = headQ.invert().multiply(gazeQ); dir = (0,0,-1).applyQuaternion(q))
  }
}
```

Expected semantics:
- Real eye gaze: the ray direction differs from the head's -Z and changes at saccade speed.
- Head-pointing fallback (what the explainer calls gaze): the ray equals the head ray. Detect it by "angle to head forward is always ~0" and
  fall back to procedural eyes.
- Per the IWER model the source has **no select events and no gamepad**. It gives **one combined ray and no eyelid data**.
  For our avatar this means: both eyes get the same direction (vergence by an assumed focus distance) and **blink stays procedural**.
- Apple's variant (`transient-pointer`) hides the eye data entirely (ray follows the hand): useless for avatars
  (<https://webkit.org/blog/15162/introducing-natural-input-for-webxr-in-apple-vision-pro/>, VERIFIED).

Consent: Quest Browser has no eye/face permission prompt in its documented site-permissions list
(<https://www.meta.com/help/quest/1406582186767703/>, VERIFIED); the headset-level "Eye tracking" toggle (default off) and per-app permission
apply (<https://www.meta.com/help/quest/8107387169303764/>, VERIFIED). So the page must show **its own** consent text (file 04) and must work
when nothing arrives.

Effort: 0.5 day (probe) + 1 day (adapter). Risk: medium (may simply not exist). Data rate: per frame (72-90 Hz). Latency: one frame.
Privacy: only a direction; stays in the page; never stored unless the user records a fixture.

### 3.2 Expression tracking (DRAFT, not shipping)

For documentation only. The draft text: <https://immersive-web.github.io/webxr-face-tracking-1/> (VERIFIED as a draft; no implementation found).

```js
// DRAFT API, will almost certainly change; behind feature detection only
const session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['expression-tracking'] });
// per frame:  const x = frame.expressions;  x?.get('brow_lowerer_left')   // 0..1 per the draft
```

Keep a 20-line adapter that maps a draft `XRExpressions` map to our `weights`, and ship it disabled. Consensus in Nov 2025 was that
values may be quantised to ~16-32 levels (REPORTED, file 01), so the smoothing in file 03 must cope with stair-stepped input.

### 3.3 Browser support matrix for (a)

| Platform | Page can get gaze | Page can get face | Note |
|---|---|---|---|
| Quest Pro, Quest Browser | **UNVERIFIED** (probe) | no | |
| Steam Frame, stock browser | no immersive session at all (DEVICE_NOTES) | no | |
| Steam Frame, community Chromium | no evidence | no | Chromium OpenXR code references no eye extension (file 01 3.5) |
| PC Chrome + SteamVR | no | no | same reason |

## 4. (b) Runtime bridge: companion program streams data to the page

### 4.1 Where the data can be read

| Source | What it reads | Format out | Licence | Sources |
|---|---|---|---|---|
| **Steam Link SteamVR driver** (Quest Pro, Steam Frame) | headset eye/face via Valve's own stack | OSC/UDP, options in SteamVR settings; Quest Pro: eye + face + tongue; Steam Frame: gaze mirrored, eyelid 0 | proprietary (Valve) | <https://wiki.resonite.com/Face_and_Eye_Tracking_(Setup)>, <https://github.com/hakumaguro/vrcft-steam-frame> (REPORTED) |
| **VRCFaceTracking (VRCFT)** | modules per runtime: ALVR, ALXR, Steam Link, Virtual Desktop | OSC to VRChat (default port 9000): `.../v2/JawOpen`, `v2/EyeLeftX`, `v2/EyeLidLeft`... | Apache-2.0 (VERIFIED repo page); Windows-centred, .NET | <https://github.com/benaclejames/VRCFaceTracking>, <https://docs.vrcft.io/docs/hardware/vr/meta/quest-pro>, <https://docs.vrcft.io/docs/tutorial-avatars/tutorial-avatars-extras/parameters> |
| **ALVR** | Quest Pro eye/face over its stream; relay to OSC | OSC | MIT (VERIFIED repo page) | <https://github.com/alvr-org/ALVR> |
| **oscavmgr** | ALVR / WiVRn (OpenXR) face relay (Quest Pro, Pico 4 Pro, XR Elite eye) | OSC (VRChat, Resonite) | MIT per its page (an earlier search snippet disagreed: check the LICENSE file before reuse) | <https://github.com/galister/oscavmgr> (REPORTED) |
| **frameeyeosc / SteamFrameEye / vrcft-steam-frame** | Steam Frame private eye data from `/dev/shm/eye-server.mmap` on the headset | OSC/UDP: VRChat mode (`FT/v2/EyeLeftX`, `EyeLidLeft`, `EyeTrackingActive` to port 9000), ETVR mode (port 8889), Live Link Face mode (port 11111); SteamFrameEye: UDP port 9021 to a VRCFT module | MIT | <https://github.com/sasaken1102r/frameeyeosc>, <https://github.com/CyrusOtter/SteamFrameEye>, <https://github.com/hakumaguro/vrcft-steam-frame> (REPORTED, new, unofficial) |
| **Meta Quest Link (PC)** | native OpenXR app on PC with Meta's runtime | extensions `XR_FB_face_tracking2`, `XR_FB_eye_tracking_social`; developer-runtime toggles may be needed | Meta SDK licence (not permissive) | <https://github.com/mbucchia/OpenXR-Eye-Trackers/wiki/Meta-Quest-Pro> (REPORTED) |
| **VRChat OSC eye addresses** | n/a (a format) | `/tracking/eye/LeftRightPitchYaw` (4 floats, degrees), `/tracking/eye/EyesClosedAmount` (float 0..1), `/tracking/eye/CenterVec` etc.; "+x right, +y up, +z forward" | docs | <https://docs.vrchat.com/docs/osc-eye-tracking> (VERIFIED) |

Why Link/Steam Link and not an app on the headset: Meta says face/eye data is reachable only through its OpenXR extensions, so "an OpenXR
application using the Oculus runtime" must run somewhere (<https://docs.vrcft.io/docs/hardware/vr/meta/quest-pro>, VERIFIED). A native companion
app on a standalone Quest would compete with the Browser for the single immersive foreground slot (INFERRED, not found in a doc): treat "background
native app + Browser WebXR on the same Quest" as **not possible** until shown otherwise.

### 4.2 What this means per headset

| Setup | Flow | Result |
|---|---|---|
| **Quest Pro standalone** | Quest Browser -> page (via `adb reverse` as `localhost`, per README) | gaze probe only; no face. |
| **Quest Pro as PC headset** | Steam Link (or ALVR/VD) -> SteamVR -> **desktop Chrome** runs our page; companion = UDP/OSC listener + WebSocket on the PC; page connects to `ws://localhost:<port>` | eyes + all face weights. Dev flow differs from standalone (desktop Chrome renders; PC GPU). This is the **recommended route to real face data**. |
| **Steam Frame via Steam Link** | same as above, using SteamVR OSC (gaze only, mirrored) or frameeyeosc (per-eye + eyelids) to a PC port | eyes; works with desktop Chrome + SteamVR (REPORTED to be a supported WebXR path on Windows, file 01 3.7). |
| **Steam Frame standalone** | community Chromium (DEVICE_NOTES) + tiny on-device server that reads the mmap and serves `ws://localhost` | per-eye gaze + eyelids, no face. Experimental: Developer Mode, private format, reduced browser sandbox. |

A page served over HTTPS (for example the deployed site) cannot open plain `ws://` to a LAN address (mixed content, INFERRED browser
rule; `localhost` is treated as trustworthy). Practical consequence: serve the page from `http://localhost` and connect to `ws://localhost`,
or terminate TLS in the companion with a certificate the headset trusts.

### 4.3 Companion program sketch (our own code, untested)

Node 20+, core `dgram` plus `ws` (MIT, already a dependency of the repo's dev tools via puppeteer). Parse OSC 1.0 messages
(address string, type tags, big-endian floats) by hand; no GPL parts required.

```js
// tools/face_bridge.mjs  (sketch)
import dgram from 'node:dgram';
import { WebSocketServer } from 'ws';

const wss = new WebSocketServer({ host: '127.0.0.1', port: 8765 });
const udp = dgram.createSocket('udp4');
let latest = {};                                     // channel -> value
udp.on('message', buf => { for (const m of parseOsc(buf)) latest[mapAddress(m.address)] = m.args[0]; });
udp.bind(9000, '127.0.0.1');                         // pretend to be the VRChat OSC receiver (port from the sender's settings)
setInterval(() => {                                  // 60 Hz coalesced frame
  const msg = JSON.stringify({ t: performance.now(), v: 1, weights: latest });
  for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
}, 1000 / 60);
```

Wire format to the page (our design): JSON for debugging, optional binary later (`Float32Array` of N weights in a fixed channel order sent once in a hello message).
Size: 70 floats = 280 B; at 60 Hz that is ~17 KB/s, irrelevant for Wi-Fi or localhost.

Unknowns to settle with a 10-line UDP dump before coding `mapAddress`: exact OSC prefixes sent by Steam Link, VRCFT and frameeyeosc.
VRCFT docs show both `/avatar/parameters/...` and bare forms and a `v2/` segment; frameeyeosc shows `FT/v2/EyeLeftX`.
Ranges: X/Y -1..1, others 0..1 (VRCFT docs). Eyelid scale in frameeyeosc: 0 closed, 0.75 relaxed, 1 widened (REPORTED), different from "1 = open"; normalise.

### 4.4 Numbers

| Item | Value | Tag |
|---|---|---|
| Eye data rate | up to ~90 Hz from the Frame's tracker (tools' README) | REPORTED |
| Face rate (Quest Pro) | follows the app frame rate / runtime rate; Meta's doc does not give a number | UNVERIFIED |
| Added latency (stream + OSC + WS) | order of 20-60 ms on a good LAN (streaming dominates) | INFERRED |
| Acceptable for avatar | gaze/blink/mouth for a mirror: yes, up to ~100 ms is not noticeable for expressions; lip-sync vs. own voice is more sensitive | INFERRED |

### 4.5 Licence summary

| Component | Licence | Use in repo |
|---|---|---|
| VRCFaceTracking | Apache-2.0 | OK as external tool; do not copy code, we need only its output |
| ALVR | MIT | external tool |
| oscavmgr | MIT (verify) | external tool |
| frameeyeosc, SteamFrameEye, vrcft-steam-frame | MIT | external tools; their formats are private, may break |
| IWER, IWSDK | MIT | already used / optional |
| MediaPipe (code) | Apache-2.0 (<https://github.com/google-ai-edge/mediapipe>, VERIFIED) | OK. **Model file licence not verified**: read the model card before shipping the `.task` file |
| Meta XR SDKs | Oculus SDK licence (not permissive) | only for an optional private native recorder, never in the repo |
| MPFB (Blender add-on) | GPL-3.0-or-later (its manifest) | used as a tool; its CC0 *data* is what ends up in the GLB; do not copy its Python into the repo |
| MakeHuman targets/assets | CC0 (<https://raw.githubusercontent.com/makehumancommunity/makehuman/master/LICENSE.md>, VERIFIED); code is AGPL | assets only |

## 5. (c) Vision fallback: webcam with MediaPipe Face Landmarker (desktop and tests)

Facts: package `@mediapipe/tasks-vision`, Apache-2.0; Face Landmarker outputs 468+ landmarks, **52 blendshapes**, and a facial transformation matrix
(<https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker/web_js>, VERIFIED docs). three.js has a working example
`examples/webgl_morphtargets_webcam.html` that maps those names onto a model's `morphTargetDictionary` and derives eye rotation from
`eyeLookIn/Out/Up/Down` (<https://github.com/mrdoob/three.js/blob/dev/examples/webgl_morphtargets_webcam.html>, VERIFIED source; present on `dev`,
not checked for the pinned 0.170 tag).

```js
// options as used in the three.js example
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';   // or a self-hosted ESM + wasm
const fileset = await FilesetResolver.forVisionTasks('<self-hosted wasm dir>');
const lm = await FaceLandmarker.createFromOptions(fileset, {
  baseOptions: { modelAssetPath: '<self-hosted face_landmarker.task>', delegate: 'GPU' },
  outputFaceBlendshapes: true,
  outputFacialTransformationMatrixes: true,
  runningMode: 'VIDEO',
  numFaces: 1,
});
// per video frame
const r = lm.detectForVideo(video, performance.now());
for (const c of r.faceBlendshapes?.[0]?.categories ?? []) weights[c.categoryName] = c.score;   // ARKit names
```

| Aspect | Value |
|---|---|
| Effort | 1-2 days (adapter + preview + calibration of neutral) |
| Risk | low; left/right naming may be mirrored relative to the avatar (INFERRED, ARKit names are the subject's side; test with a wink) |
| Rate / latency | camera-limited (30 fps typical) + inference; INFERRED tens of ms on desktop GPU |
| Gaze | rough: derived from eye-look blendshapes, not calibrated gaze |
| Permissions | `getUserMedia` camera prompt, secure context |
| Privacy | video stays in the page. The npm description points to a privacy notice (<https://goo.gle/mediapipe-privacy>): read it, and **self-host the wasm and model** so nothing is fetched at run time and no CDN sees the user |
| Use | desktop mirror preview, lets everyone without a headset see the full pipeline; source for recorded fixtures (not for headset use: the camera does not see an HMD-covered face) |

## 6. Mic fallback for mouth (summary; design in file 03)

- Simplest: Web Audio `AnalyserNode` RMS to jaw-open weight, no dependency.
- Better: wLipSync (MIT) gives phoneme weights from the microphone via AudioWorklet + WASM; it needs a **profile calibrated in Unity's uLipSync**, and a secure context
  (<https://github.com/mrxz/wLipSync>, REPORTED via fetcher). Weights: `lipsyncNode.weights`, `lipsyncNode.volume`.
- Meta's own lip-sync / audio-to-expression is native-only (`XR_FB_face_tracking2` audio source on Quest 2/3/3S, "up to 10 s initial voice connection delay"; <https://developers.meta.com/horizon/documentation/unity/move-face-tracking/>, VERIFIED).
- Permissions: `getUserMedia` microphone prompt. In a headset the page needs the mic permission of the browser; the same consent text as face data.

## 7. (d) Recorded-data and replay format

Existing fixtures (`src/replay.js`) are `{version, name, note, frames:[record]}` with head/hands, and the recorder drops `eyes`.
Do **not** overload them. Add a parallel **face stream** (our design):

```json
{ "version": 1, "name": "talk_and_look", "source": "mediapipe|bridge-osc|synthetic",
  "rate": 60, "channels": ["eyeBlinkLeft", "eyeBlinkRight", "jawOpen", "..."],
  "gazeChannels": ["gazeLx","gazeLy","gazeRx","gazeRy"],
  "frames": [ [0.000, 0.0, 0.0, 0.1, 0.0], [0.016, 0.0, 0.0, 0.2, 0.0] ] }
```

- Compact rows: `[t, v0..vn]`; 70 channels x 60 Hz x 60 s = 252 k numbers, about 1 MB as JSON with 2 decimals (INFERRED arithmetic), so keep fixtures to 5-20 s clips.
- Players interpolate linearly by time (same rule as `sampleFixture`), loop optional.
- Record from: the webcam path, the bridge (while wearing a Quest Pro through Steam Link) or the synthetic generator (blink trains, saccade sequences, visemes sweep, smile ramp).
- Never record by default; recording is an explicit button and the file stays local (file 04).

## 8. What we need from the user, per option

| Option | Needs |
|---|---|
| Gaze probe (Quest Pro) | Eye tracking on + calibrated (Settings -> Movement tracking -> Eye tracking), Browser up to date, `adb reverse` as in README; allow the page's consent text |
| PC bridge, Quest Pro | Natural facial expressions + Eye tracking on; Steam Link (or ALVR/Virtual Desktop) working with SteamVR; SteamVR advanced settings -> Steam Link -> enable OSC and share eye/face data; a PC where Chrome sees SteamVR as OpenXR runtime; allow us a small Node tool |
| Steam Frame eyes | Steam Link to PC (gaze only) or Developer Mode + SSH for the on-device tool (REPORTED requirement) |
| Webcam path | a webcam and camera permission; desktop only |
| Mic path | microphone permission |

# 01 - Eye and face tracking in WebXR and on the target headsets: status (2026-10-01)

Scope: what exists, what ships, what is only a proposal. Steam Frame browser/WebXR basics are **not repeated**
here, see [../DEVICE_NOTES.md](../DEVICE_NOTES.md).

All URLs were accessed on **2026-10-01**. Reliability tags:

- **VERIFIED**: official docs, spec/registry text, source code, changelog.
- **REPORTED**: forum, blog, press, community repo README, meeting minutes (may be wrong or outdated).
- **INFERRED/UNVERIFIED**: my deduction or something I could not confirm. Not to be built on without a test.

Method note: most pages were read through a summarising fetcher, so wording marked as a quote should be
re-checked on the page before it goes into user-facing text. Where the fetcher said "not mentioned", that only means
"not in the part of the page it saw".

## 1. Short answer

1. **No browser ships eye-gaze or face-expression tracking as a documented WebXR API that a normal page can use today.**
   - The W3C WebXR Device API has no eye/face module.
   - The only face proposal ("expression tracking") is an old, unofficial draft that was re-discussed in Nov 2025 and has no
     reported implementation.
2. **Meta's own emulator (IWER 2.5.0, MIT) models a WebXR "gaze" input source behind feature strings `gaze-tracking` / `eye-tracking`.**
   - This means *something* exists on the Meta side, at least for the new Meta VR Glasses.
   - Whether the **Quest Pro + Quest Browser** gives it to a page is **UNVERIFIED**. It costs five minutes to test
     (section 4).
   - Even if it works, it is a *single viewer-relative gaze ray* (the shape built for gaze-and-pinch UI), not per-eye angles and not eyelid openness.
3. **Face expressions (jaw, mouth, brows, cheeks) are not reachable from the Quest Browser or Chrome at all today.** They need an
   OpenXR app (native) or a bridge that reads them and forwards them to the page.
4. **Steam Frame has eye tracking but no face tracking.**
   - Eye data is documented to apps only as one combined gaze vector (OpenXR `XR_EXT_eye_gaze_interaction`, OpenVR `eyetracking` action).
   - Per-eye gaze and eyelid openness exist only in a private, undocumented on-device format that community tools already read.
   - Valve points to the expansion port for third-party face-tracking add-ons.
5. **Quest Pro** has both (per-eye gaze via `XR_FB_eye_tracking_social`; 63 or 70 face weights via `XR_FB_face_tracking` / `XR_FB_face_tracking2`),
   for native apps and, via Steam Link / ALVR / Virtual Desktop, for PC-side tools.

## 2. Summary table: feature x platform

Cells: status, then source tag. "Page" means a normal web page with a WebXR session.

| Feature | Quest Pro native (OpenXR/Unity app) | Quest Browser WebXR (page) | Steam Frame native (OpenXR/OpenVR) | Steam Frame browser (page) | SteamVR + PC Chrome/Edge (page) |
|---|---|---|---|---|---|
| Combined gaze ray | yes (VERIFIED) | `gaze` input source behind `gaze-tracking`/`eye-tracking`: **UNVERIFIED on Quest Pro** | yes, `XR_EXT_eye_gaze_interaction` / OpenVR action (VERIFIED) | none: stock build has no immersive WebXR (VERIFIED, DEVICE_NOTES) | none: Chromium's OpenXR layer references no eye extension (VERIFIED at HEAD, see 3.5) |
| Per-eye gaze direction | yes, `XR_FB_eye_tracking_social` (VERIFIED) | not documented | not in public API; private shared memory, read by community tools (REPORTED) | none | none via WebXR; PC bridge possible for Quest Pro (REPORTED) |
| Eyelid openness / blink | yes: `EYES_CLOSED_L/R` in the face weights (VERIFIED) | not documented | private shared memory only (REPORTED); Steam Link OSC "eyelid value always 0" (REPORTED) | none | none via WebXR; bridge for Quest Pro |
| Face expression weights (jaw, mouth, brows, cheeks) | yes: 63 / 70 weights (VERIFIED); camera-based on Pro only | not available; proposal only (VERIFIED draft, no implementation found) | no face tracking hardware (REPORTED) | none | none via WebXR; bridge for Quest Pro (REPORTED) |
| Tongue | yes, `XR_FB_face_tracking2`, 7 weights (VERIFIED) | no | no | no | bridge only (Steam Link added tongue tracking, REPORTED) |
| User consent | manifest permission + in-headset toggle + per-app permission (VERIFIED) | no page-facing consent for eyes/face exists (site-permissions page lists camera, virtual camera, spatial data, hand/body tracking only; VERIFIED page) | OS-level, not documented in public pages I found | n/a | n/a (bridge is a local program the user starts) |

## 3. Details by layer

### 3.1 WebXR Device API (W3C)

| Topic | Finding | Source / tag |
|---|---|---|
| Spec status | W3C Candidate Recommendation Draft dated 2026-06-09 (as shown by the fetched page) | <https://www.w3.org/TR/webxr/> (REPORTED via fetcher) |
| `targetRayMode` values | `gaze`, `tracked-pointer`, `screen`, `transient-pointer` | <https://developer.mozilla.org/en-US/docs/Web/API/XRInputSource/targetRayMode> (VERIFIED docs) |
| `gaze` semantics | The Input explainer says gaze input "do[es] not have their own tracking mechanism and instead use the viewer's head position". Its `targetRaySpace` is a separate object from `viewerSpace` "to keep the API flexible enough to add eye tracking in the future". MDN words it as "the direction the user is looking", so the two sources differ in tone. | <https://immersive-web.github.io/webxr/input-explainer.html> (VERIFIED); MDN link above |
| `transient-pointer` | Created for OS-level "intent" input such as gaze-and-pinch. Exists only while the pinch lasts. Its ray starts between the eyes in the gaze direction at gesture start, then follows the hand, **not the eyes**. Raw eye data is deliberately not exposed. | <https://webkit.org/blog/15162/introducing-natural-input-for-webxr-in-apple-vision-pro/> (VERIFIED, WebKit blog) |
| Hand input module | Separate community/WG spec, 25 joints, feature `hand-tracking`. This is the model for how a tracking module is shaped (feature descriptor + per-frame data + consent). | <https://github.com/immersive-web/webxr-hand-input> (REPORTED via fetcher) |
| Secure context | WebXR (and MDN's `targetRayMode`) is HTTPS-only; `http://localhost` counts. | MDN link above; project README |

### 3.2 Face / expression tracking proposal ("expression-tracking")

| Item | Finding | Source / tag |
|---|---|---|
| Name and home | "WebXR Expression Tracking - Level 1" (old name "face tracking"). Repo `immersive-web/webxr-face-tracking-1`. Editor: Rik Cabanier (Meta). | <https://immersive-web.github.io/webxr-face-tracking-1/> (VERIFIED draft) |
| Status | "Unofficial Proposal Draft", dated 2022-12-13. Repo: 4 commits, 2 open issues (one is a Nov 2025 face-to-face agenda item). No browser implementation mentioned. | <https://github.com/immersive-web/webxr-face-tracking-1>, <https://github.com/immersive-web/webxr-face-tracking-1/issues> (REPORTED via fetcher) |
| Feature descriptor | `expression-tracking` | spec link above (VERIFIED draft) |
| Interfaces | `XRExpression` enum with **63** values (the same count and style as `XR_FB_face_tracking`), `XRExpressions` map-like (`size`, `get(key)`), `XRFrame.expressions` | spec link above (VERIFIED draft) |
| Names | `brow_lowerer_left`-style snake case, e.g. brow, cheek, chin, eyes closed/look, jaw, lid, lip (corner, funneler, pressor, pucker, stretcher, suck, tightener), mouth, nose. A UA may support a subset and the subset may change during the session. | spec link above (VERIFIED draft) |
| Privacy text | Explicit consent at session creation; data anonymised; only `immersive-*` sessions; "rounding over noising". | spec link above (VERIFIED draft) |
| Nov 2025 F2F | Agenda item immersive-web/administrivia#227 (closed 2025-11-14) was discussed on 2025-11-21. Reported content: Pico/ByteDance presented the topic; concern that "something without eyes seems incomplete"; **quantisation to roughly 16-32 values** floated as a privacy measure; "general consensus that there is appetite ... If bajones implements, cabanier will as well"; a new repo for the proposal to be created. No API shape was decided. | <https://github.com/immersive-web/administrivia/issues/227>, <https://www.w3.org/2025/11/21-immersive-web-irc> (REPORTED: IRC log read through the fetcher) |
| Implementations | None found: not in the Meta Horizon Browser release notes (latest seen: Browser 150.1, 2026-08-28; no mention of eye/face/expression), not in Chrome-for-Android-XR's supported-module list (Device API, AR, Gamepads, Hit Test, Hand Input, Anchors, Depth, Light Estimation). | <https://developers.meta.com/horizon/documentation/web/browser-release-notes/>, <https://developer.android.com/develop/xr/web> (REPORTED via fetcher; absence of evidence) |

Consequence: if this API ever ships it will probably be quantised or coarse (privacy), so the avatar code must accept
low-resolution, subset, and changing sets of expression channels. **Design the input layer as "named channels, 0..1, any subset".**

### 3.3 Meta Quest Browser and Meta's WebXR direction

| Item | Finding | Source / tag |
|---|---|---|
| Documented WebXR features | The Meta WebXR overview page lists mixed reality, hand tracking, layers, system keyboard, performance. No eye/face. | <https://developers.meta.com/horizon/documentation/web/webxr-overview/> (REPORTED via fetcher) |
| Site permissions in Quest Browser | The user can allow/block per site: headset camera, virtual camera, spatial data, **hand and body tracking**. No eye or face permission. | <https://www.meta.com/help/quest/1406582186767703/> (VERIFIED; page is the Danish locale) |
| Experimental flags | `chrome://flags` -> "WebXR Experiments" (earlier used for body tracking in Browser 32.0, 2024-03; WebGPU-in-WebXR experiment in Browser 146.0, 2026-04). Whether a flag exists for gaze/eye/face: **not found**. | <https://www.uploadvr.com/quest-web-browser-experimental-colocation-webxr/>, search results for Browser 146 (REPORTED) |
| WebXR body tracking | Experimental; 83 joints; Quest 2/Pro/3/3S. Shows Meta ships new tracking modules to WebXR behind flags first. | search results via <https://forum.babylonjs.com/t/webxr-body-tracking/63258> (REPORTED) |
| IWSDK 1.0 gaze-and-pinch | Meta's Immersive Web SDK (MIT) reached 1.0 on 2026-09-24 with gaze-and-pinch. Config key `gazeTracking: true` (optional) or `{required: true}`; "falls back to head pointing" if the runtime gives no usable gaze pose. The press article states Meta **did not say** which Horizon OS version or browser supports it. | <https://developers.meta.com/horizon/documentation/iwsdk/guides/get-started-glasses/>, <https://mixed-news.com/en/meta-immersive-web-sdk-1-0-gaze-and-pinch-webxr/> (REPORTED) |
| Meta VR Glasses | New standalone headset (reported: spring 2027, controller-optional, eye + hand tracking). Eye tracking "is available on Meta VR Glasses and Meta Quest Pro". Needs user consent. | <https://developers.meta.com/horizon/essentials/horizon-os-immersive-features/> (VERIFIED), <https://vr.org/articles/meta-vr-glasses-store-hand-tracked-apps-first-v207-sdk-2026> (REPORTED) |
| What the IWER source says | `node_modules/iwer` 2.5.0 (Meta, MIT) defines `GAZE_TRACKING_FEATURES = ['gaze-tracking','eye-tracking']` ("two descriptors are compatibility aliases for one source"). Its `XRGazeInput` is an `XRInputSource` with `targetRayMode = 'gaze'`, `profiles = ['eye-gaze']`, no gamepad, **no select events**, pose expressed relative to the viewer. The Meta Quest 3 device config lists both features. | read directly from the installed package (VERIFIED: source, local) |

Reading of this evidence (INFERRED): the real browser very likely requests/accepts the same descriptors and returns an input
source with `targetRayMode: 'gaze'` and profile `eye-gaze`, designed to be combined with a pinch from a hand source. The
emulator authors are Meta's, but an emulator is not the browser: **do not assume Quest Pro Browser does this until the probe
page in section 4 confirms it.**

### 3.4 Android XR / Chrome (reference only)

| Item | Finding | Source / tag |
|---|---|---|
| Native permissions | `android.permission.EYE_TRACKING_COARSE` (eye pose/status for avatars), `EYE_TRACKING_FINE` (gaze for selection), `FACE_TRACKING` (facial expressions), `HAND_TRACKING`; all are runtime "dangerous" permissions. | <https://developer.android.com/develop/xr/permissions> (VERIFIED docs) |
| WebXR | "All WebXR APIs require the 3d mapping and camera tracking permission. Access tracked face, eye, and hand data are also protected by permissions." Face/eye are **not** in the list of supported WebXR modules. Permission is per domain; Chrome prompts each. | <https://developer.android.com/develop/xr/web> (REPORTED via fetcher) |
| OpenXR | `XR_ANDROID_eye_tracking` for eye pose; `XR_EXT_eye_gaze_interaction` for interaction. | <https://developer.android.com/develop/xr/openxr/extensions/XR_ANDROID_eye_tracking> (listed in search results; page not read) |
| Why it matters | The permission split coarse (avatar) vs fine (interaction) is a useful model for our consent UI: avatar eyes need only the coarse level. | docs above |

### 3.5 OpenXR layer underneath

| Extension | What it gives | Facts | Source / tag |
|---|---|---|---|
| `XR_EXT_eye_gaze_interaction` | One gaze pose via an input action; "from a point between the two eyes"; `supportsEyeGazeInteraction` flag | Extension number 31; Valve says Steam Frame eye tracking support "uses" it | <https://registry.khronos.org/OpenXR/specs/1.0/man/html/XrSystemEyeGazeInteractionPropertiesEXT.html> (search result), <https://partner.steamgames.com/doc/steamhardware/steamframe/input> (VERIFIED) |
| `XR_FB_eye_tracking_social` | Per-eye gaze (`XrEyeGazesFB`, `xrGetEyeGazesFB`), for avatars | Extension number 203; not ratified; needs the Meta permission `com.oculus.permission.EYE_TRACKING` and the in-headset toggle | <https://registry.khronos.org/OpenXR/specs/1.1/man/html/XR_FB_eye_tracking_social.html>, <https://developers.meta.com/horizon/documentation/unity/move-eye-tracking/> (VERIFIED) |
| `XR_FB_face_tracking` | 63 expression weights (FACS-style) | Needs `com.oculus.permission.FACE_TRACKING`; Quest Pro only (camera) | <https://developers.meta.com/horizon/documentation/unity/move-face-tracking/> (VERIFIED) |
| `XR_FB_face_tracking2` | **70** weights = the 63 + 7 tongue weights; visual or audio data source | Quest 2/3/3S use "Audio To Expressions" (mic-based). Confidence values "currently unpopulated" per Meta | same Meta page; enum list: <https://registry.khronos.org/OpenXR/specs/1.1/man/html/XrFaceExpression2FB.html> (VERIFIED) |
| `XR_HTC_facial_tracking` | HTC eye + lip tracking | Exists (Vive); **not researched** here | - |
| `XR_ANDROID_eye_tracking` | See 3.4 | | |
| Chromium's OpenXR code | The extension helper (`device/vr/openxr/openxr_extension_helper.cc`, HEAD) references hand tracking, anchors, hit test, composition layers, some Android extensions; **no eye-gaze, face, or body tracking** | <https://chromium.googlesource.com/chromium/src/+/HEAD/device/vr/openxr/openxr_extension_helper.cc> (REPORTED via fetcher; the file may be truncated in the summary) |

Important detail for our mapping: the 63/70 weights contain `EYES_CLOSED_L/R`, four `EYES_LOOK_*_L/R` pairs, `UPPER_LID_RAISER_L/R`
(that is "eyes wide"), `LID_TIGHTENER_L/R` (squint), so a face-tracking stream can *also* drive gaze and blink. The full enum
(verified) is reproduced in [03_avatar_mapping_design.md](03_avatar_mapping_design.md).

### 3.6 Quest Pro user-side settings and privacy

| Item | Finding | Source / tag |
|---|---|---|
| Where | Settings -> Movement tracking -> Eye tracking (toggle, then optional calibration) and Natural facial expressions (face tracking). | <https://www.meta.com/help/quest/8107387169303764/> (REPORTED via search snippet), <https://docs.vrcft.io/docs/hardware/vr/meta/quest-pro> (VERIFIED docs) |
| Defaults | Eye tracking is **off by default**; can be paused from quick settings. | Meta help page above (REPORTED) |
| Per-app permission | Settings -> Privacy and Security -> App permissions -> eye tracking per app; the device-level toggle must be on first. | <https://www.meta.com/help/quest/8107387169303764/> (VERIFIED, Danish locale) |
| Data handling | "Images of your eyes never leave the headset and are deleted after processing"; apps cannot access raw eye images, only numeric gaze estimates. | same page (VERIFIED, Danish locale, translated by me) |
| Developer duty | Facial expression data is user data under Meta's Developer Data Use Policy: explicit consent, privacy policy. | <https://developers.meta.com/horizon/documentation/unity/move-face-tracking/> (VERIFIED) |

### 3.7 Valve: Steam Frame and SteamVR

| Item | Finding | Source / tag |
|---|---|---|
| Hardware | Two inward cameras track the eyes; low-latency eye tracking drives **foveated streaming**. | <https://vrarwiki.com/wiki/Steam_Frame>, <https://www.pcgamer.com/hardware/vr-hardware/foveated-streaming-genius-tech/> (REPORTED) |
| API for developers | "Our current support for eye tracking uses the `XR_EXT_eye_gaze_interaction` OpenXR extension." OpenVR: `IVRInput::GetEyeTrackingDataRelativeToNow` and `GetEyeTrackingDataForNextFrame` with an action of type `"eyetracking"`. The input page says nothing about face tracking. | <https://partner.steamgames.com/doc/steamhardware/steamframe/input> (VERIFIED) |
| Use beyond foveation | Road to VR (2025-11-12): "Aside from foveated streaming tech, it feels like Valve is only scraping the surface with eye-tracking." Review (2026-09-16): no mention of eye data given to apps. | <https://roadtovr.com/steam-frame-hands-on-valve-vr-headset-index-2/>, <https://roadtovr.com/valve-steam-frame-review/> (REPORTED) |
| Face tracking | No face tracking hardware in the spec sheet. Valve described a hidden expansion port (PCIe Gen 4 plus a dual 2.5 Gbps camera interface) and said it will publish CAD for third parties; categories named at announcement included face tracking. | <https://vr.org/steam-frame-specs>, <https://roadtovr.com/steam-frame-hands-on-valve-vr-headset-index-2/> (REPORTED) |
| Private per-eye data | Community tools read per-eye gaze and eyelid openness from the on-device shared-memory object `/dev/shm/eye-server.mmap` (~90 Hz) and send OSC/UDP. They say: public OpenXR/OpenVR do not expose eyelids; the format is "private, undocumented ... a Frame update can change"; Developer Mode + SSH needed; tested with SteamOS build 20260922 ("eye data version 4"), VRCFaceTracking 5.4.5, SteamVR 2.17.10 (verified by their authors 2026-09-25/26). MIT licence. | <https://github.com/hakumaguro/vrcft-steam-frame>, <https://github.com/sasaken1102r/frameeyeosc>, <https://github.com/CyrusOtter/SteamFrameEye> (REPORTED; very new, 1-2 weeks old) |
| Steam Link fallback | Steam Link's own OSC output (port 9015 in the setup guides) gives gaze "with both eyes mirrored" and eyelid value always 0 on the Frame. | <https://github.com/hakumaguro/vrcft-steam-frame> (REPORTED) |
| SteamVR OSC options for Quest Pro | In SteamVR settings (Advanced settings = Show) -> Steam Link: enable OSC, "Share eye tracking data to other apps on this PC via OSC", "Share face tracking data ...". Tongue tracking since a 2024 update. | <https://wiki.resonite.com/Face_and_Eye_Tracking_(Setup)>, <https://www.uploadvr.com/steam-link-quest-pro-tongue-tracking/> (REPORTED) |
| PC Chrome with SteamVR | Chrome/Edge use OpenXR on desktop; SteamVR's OpenXR runtime (SteamVR 1.16.8 or later) must support `XR_EXT_win32_appcontainer_compatible`. Firefox: reported unsupported. | <https://immersiveweb.dev/chrome-support.html> returned 404 for me; claim comes from a search summary (REPORTED, weak) |

### 3.8 Other bridges that already see Quest Pro data on the PC (for 02)

| Route | Fact | Source / tag |
|---|---|---|
| VRCFaceTracking (VRCFT) modules for Quest Pro | Work through ALVR, ALXR, Steam Link, Virtual Desktop. Needs "Natural Facial Expressions" and "Eye Tracking" turned on in the headset. | <https://docs.vrcft.io/docs/hardware/vr/meta/quest-pro> (VERIFIED docs) |
| Why a streaming bridge is needed | Meta data "only accessible through Meta's Oculus OpenXR extensions means there must be an OpenXR application using the Oculus runtime running somewhere". | same page (VERIFIED) |
| Quest Link on PC | Meta's runtime exposes hand, face, eye tracking; some features need developer-runtime toggles ("Eye tracking over Oculus Link"). A tool page now says Quest Pro no longer needs its API layer for eye tracking over Link. | <https://github.com/mbucchia/OpenXR-Eye-Trackers/wiki/Meta-Quest-Pro> (REPORTED; the toggle names come from a search snippet) |

## 4. Five-minute probe to run on the Quest Pro (resolves the biggest unknown)

Write a tiny page (not in this research folder) that requests an immersive session with
`optionalFeatures: ['local-floor','hand-tracking','gaze-tracking','eye-tracking']`, then logs:

- `session.enabledFeatures` (is `gaze-tracking` or `eye-tracking` listed?),
- every `inputSource` on `inputsourceschange` with `targetRayMode`, `profiles`, `handedness`,
- whether an input source with `targetRayMode === 'gaze'` has a moving `targetRaySpace` pose relative to `viewerSpace`.

Interpretation: if no `gaze` source appears while eye tracking is enabled in the headset, the browser does not give eye data to
pages. If one appears, check whether its ray differs from the head ray (it does if it is real eye gaze). Code skeleton in
[02_implementation_options.md](02_implementation_options.md). Unknown strings in `optionalFeatures` are expected to be ignored
by the browser (spec behaviour for optional features; INFERRED, not re-verified), but they must **not** go into `requiredFeatures`.

## 5. Open questions (could not be settled by documents)

1. Does Quest Browser on a Quest Pro return a `gaze` input source today? (probe above)
2. Is there any hidden `chrome://flags` entry for expression/face tracking in Browser 150.x? Not found in any doc.
3. Does a community Steam Frame Chromium build expose eye gaze through `XR_EXT_eye_gaze_interaction`? The Chromium sources checked reference none.
4. Is the Steam Frame private eye format stable? The tool authors say no.
5. Exact address format of Steam Link's OSC output (is it VRChat `/avatar/parameters/...` style?). Capture it with a UDP dump before coding.

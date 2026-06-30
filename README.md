<div align="center">

# FocusBuddy

**Dual-device accountability app with AI-powered face verification**

[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript)](https://typescriptlang.org)
[![Firebase](https://img.shields.io/badge/Firebase-12-FFCA28?logo=firebase)](https://firebase.google.com)
[![TensorFlow.js](https://img.shields.io/badge/TF.js-4.x-FF6F00?logo=tensorflow)](https://www.tensorflow.org/js)
[![Android](https://img.shields.io/badge/Android-Kotlin-3DDC84?logo=android)](https://developer.android.com)

</div>

---

## What is FocusBuddy?

FocusBuddy is a remote-controlled focus session app. An **Admin** (supervisor) locks a **Buddy's** (friend's) phone into focus mode, restricting it to whitelisted apps only. The Buddy's device uses real-time on-device AI face verification to ensure the registered user stays present — if a stranger picks up the phone, focus mode pauses automatically.

### How It Works

```
Admin Device                          Buddy Device
┌──────────────┐    Firebase Sync    ┌──────────────────────┐
│ Create Session├───────────────────►│ Join Session          │
│ Set Timer     │                    │ Register Face (3-pose)│
│ Pick Apps     │◄──────────────────►│ Kiosk Lock Activated  │
│ Monitor Status│    Real-time       │ Face Engine Running   │
│ Approve/End   │                    │ App Blocking Active   │
└──────────────┘                    └──────────────────────┘
```

### Face Security State Machine

| Camera Sees | State | Behavior |
|-------------|-------|----------|
| Buddy alone | **LOCKED** | Focus mode ON, low FPS scanning |
| Buddy + stranger | **LOCKED** | Focus mode ON, stranger alert fired |
| Stranger only (no buddy) | **PAUSED** | Phone unlocked — buddy handed it away |
| Nobody / dark / covered | **LOCKED** | Anti-escape — can't bypass by covering camera |
| Screen asleep | **RESERVE** | 0.5 FPS polling, re-locks on wake |

---

## Architecture

### Frontend — React + TypeScript + Vite

| File | Purpose |
|------|---------|
| `src/App.tsx` | Main app — Admin/Buddy flows, session management, Firestore sync |
| `src/components/FaceSecurityEngine.tsx` | 1900+ line on-device face security engine |
| `src/components/Onboarding.tsx` | 3-step intro flow |
| `src/firebase.ts` | Firestore init with IndexedDB offline persistence |

### Face Security Engine

Built on **TensorFlow.js + MediaPipe FaceMesh** (478 landmarks including iris refinement).

**Identity System:**
- 120-dimensional geometric descriptor (16 key landmarks, all pairwise distances)
- 3-stage multi-pose enrollment: center / left / right (4 samples each = 12 total)
- Dual-metric matching: cosine similarity >= 0.82 AND euclidean distance <= 0.25
- Hysteresis: 0.04 leniency when already locked (prevents flicker)
- 10-frame temporal consensus with asymmetric thresholds (70% to lock, 30% to unlock)

**13 Passive Liveness Layers:**

| # | Layer | What It Catches |
|---|-------|-----------------|
| 1 | Temporal Blink (EAR) | No blinking = photo |
| 2 | Head Pose Challenge | Static head = photo or mannequin |
| 3 | Iris Asymmetry | Perfect iris symmetry = flat printed image |
| 4 | rPPG Blood Flow | Green channel pulse — no fluctuation = not alive |
| 5 | 3D Depth Geometry | FaceMesh z-coords — flat depth profile = screen/photo |
| 6 | Specular Reflection | Screen glare / uniform bright spots |
| 7 | Color Space Skin | Chromaticity deviation from natural skin tones |
| 8 | Moire Frequency | Screen scanline interference patterns |
| 9 | Histogram Consistency | Frozen or looping video feed |
| 10 | Attention Gaze | Iris micro-movement variance — static gaze = fake |
| 11 | Replay Detection | dHash perceptual frame dedup — catches video loops |
| 12 | LBP Texture | Local Binary Pattern entropy — smooth surface = spoof |
| 13 | Boundary Detection | Phone/photo edges visible around face |

> Ported and adapted from [FaceRecog-Engine](https://github.com/onlykushalll/Utils/tree/main/~FaceRecog-Engine~) (Python/InsightFace/MiDaS) to browser-native TF.js.

### Android Native — Kotlin

| Component | Role |
|-----------|------|
| `AppBlockAccessibilityService` | Intercepts window changes, blocks non-whitelisted apps, escalation after 2s |
| `MainActivity` | WebView host, JS bridge (`AndroidBridge`), key interception (Back/Home/Recents) |
| `WhitelistManager` | Essential packages always allowed (dialer, SMS, clock, calculator, calendar, camera, emergency) |
| `GlobalState` | Session state singleton, SharedPreferences persistence |
| `BootReceiver` | Re-activates kiosk on device reboot |

**Hard-blocked across OEMs:** Settings, Package Installer, Developer Options, Permission Controller — Samsung, Xiaomi, OnePlus, Huawei, Oppo, Vivo, Realme, Asus, Lenovo, Motorola variants.

### Firestore Security Rules

- Admin-only session control with scoped buddy operations
- Buddy can only: add self to `buddyIds`, end expired sessions
- Field-level validation on all documents
- Immutable `adminDeviceId` constraint

---

## Setup

### Prerequisites

- Node.js 18+
- Android Studio (for native build)
- Firebase project with Firestore + Anonymous Auth

### Development

```bash
npm install
npm run dev
```

### Android Build

```bash
cd android
./gradlew assembleDebug
```

### Firebase Deploy

```bash
firebase deploy --only firestore:rules
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, TypeScript 5.6, Vite 6 |
| UI | Tailwind CSS, Lucide Icons, motion/react |
| Face AI | TensorFlow.js, MediaPipe FaceMesh (478-point) |
| Backend | Firebase Firestore (real-time sync) |
| Auth | Firebase Anonymous Auth |
| Android | Kotlin, AccessibilityService, WebView |

---

## Security Model

- **Fail-closed** — No descriptor = locked. Camera blocked = locked. No face = locked.
- **Anti-escape** — Covering camera keeps phone locked, not paused.
- **Kiosk enforcement** — AccessibilityService + key interception + hard-blocked Settings/Installer.
- **13-layer passive liveness** — No active challenges needed for baseline spoof detection.
- **Temporal consensus** — Single-frame spoofs can't flip state; needs sustained presence.

---

## License

Private project by [@onlykushalll](https://github.com/onlykushalll).

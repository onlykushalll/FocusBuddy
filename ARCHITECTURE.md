# Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                       Admin Device                          │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ React App (src/App.tsx)                              │   │
│  │ • Create session with timer + app whitelist          │   │
│  │ • Monitor buddy status in real-time                  │   │
│  │ • Approve/reject buddy join requests                 │   │
│  │ • End session or accept stop requests                │   │
│  └──────────────────────┬──────────────────────────────┘   │
└─────────────────────────┼───────────────────────────────────┘
                          │ Firestore Real-time Sync
                          │ (onSnapshot listeners)
┌─────────────────────────┼───────────────────────────────────┐
│                    Firebase Cloud                            │
│  ┌──────────────────────┴──────────────────────────────┐   │
│  │ Firestore Database                                   │   │
│  │ • sessions/{id}         — session state + config     │   │
│  │ • sessions/{id}/buddies — per-buddy status + face    │   │
│  │ • users/{uid}           — user profiles              │   │
│  │                                                      │   │
│  │ Security Rules (firestore.rules)                     │   │
│  │ • Admin-only session control                         │   │
│  │ • Buddy scoped to self-operations only               │   │
│  │ • Field-level validation on all writes               │   │
│  └──────────────────────┬──────────────────────────────┘   │
│                          │ Anonymous Auth                    │
└─────────────────────────┼───────────────────────────────────┘
                          │
┌─────────────────────────┼───────────────────────────────────┐
│                       Buddy Device                           │
│  ┌──────────────────────┴──────────────────────────────┐   │
│  │ React App in WebView (MainActivity.kt)               │   │
│  │ • Join session via code                              │   │
│  │ • Face registration (3-pose, 12-sample)              │   │
│  │ • Real-time face security scanning                   │   │
│  └──────────────────────┬──────────────────────────────┘   │
│                          │ JS Bridge (AndroidBridge)         │
│  ┌──────────────────────┴──────────────────────────────┐   │
│  │ Android Native Layer                                 │   │
│  │ • AppBlockAccessibilityService — app blocking        │   │
│  │ • WhitelistManager — essential apps always allowed   │   │
│  │ • Key interception — Back/Home/Recents blocked       │   │
│  │ • BootReceiver — re-lock on reboot                   │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## Face Security Engine Pipeline

```
Camera Frame (30fps)
    │
    ▼
┌──────────────────┐
│ TF.js FaceMesh   │ 478 landmarks + iris refinement
│ Face Detection    │
└────────┬─────────┘
         │
    ┌────┴────┐
    │         │
    ▼         ▼
┌────────┐ ┌─────────────────────────┐
│Identity│ │ 13 Passive Liveness     │
│Matching│ │ Layers (parallel)       │
│        │ │                         │
│ 120-dim│ │ 1. Blink (EAR)          │
│ cosine │ │ 2. Head pose variance   │
│ + euclid│ │ 3. Iris asymmetry       │
│        │ │ 4. rPPG blood flow      │
│        │ │ 5. 3D depth geometry    │
│        │ │ 6. Specular reflection  │
│        │ │ 7. Color space skin     │
│        │ │ 8. Moiré frequency      │
│        │ │ 9. Histogram stability  │
│        │ │ 10. Attention gaze      │
│        │ │ 11. Replay detection    │
│        │ │ 12. LBP texture         │
│        │ │ 13. Boundary detection  │
└───┬────┘ └────────────┬────────────┘
    │                   │
    ▼                   ▼
┌─────────────────────────────┐
│ Temporal Consensus Engine   │
│ • 10-frame sliding window   │
│ • 70% buddy-present to lock │
│ • 30% buddy-absent to pause │
│ • Asymmetric = flicker-free │
└──────────┬──────────────────┘
           │
           ▼
   State Machine Output
   (LOCKED / PAUSED / RESERVE)
           │
           ▼
   Android Kiosk Control
   (enable/disable app blocking)
```

## Data Flow: Face Registration → Verification

```
Registration (3-pose enrollment):
  Center (4 frames) → average → centerDescriptor[120]
  Left   (4 frames) → average → leftDescriptor[120]
  Right  (4 frames) → average → rightDescriptor[120]
       │
       ▼
  MultiPoseDescriptor { center, left, right }
       │
       ▼
  Firestore: sessions/{id}/buddies/{uid}.faceDescriptor
       │
       ▼
  Admin approves → Buddy device loads descriptor
       │
       ▼
  Live verification: compare each frame against all 3 poses
  Match = best of (center, left, right) passes dual threshold
```

## Key Design Decisions

**On-device inference**: All face processing runs locally in the browser via TF.js. No frames leave the device. Privacy by architecture.

**Geometric descriptors over neural embeddings**: Browser environment lacks ONNX runtime for ArcFace/AdaFace. 120-dim geometric descriptors from FaceMesh landmarks provide sufficient discrimination for 1:1 verification (not 1:N identification).

**Fail-closed security**: Every ambiguous state defaults to LOCKED. Camera covered = locked. No face detected = locked. Model loading failure = locked. This prevents bypass by inducing errors.

**Passive liveness only**: No active challenges ("blink now", "turn left"). All 13 layers run silently in background. Active challenges are UX-hostile during focus sessions and can be pre-recorded.

**AccessibilityService over Device Admin**: Android's Device Admin API is deprecated. AccessibilityService provides deeper control (window change interception) without requiring device owner provisioning.

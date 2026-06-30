# Changelog

## [1.1.0] — 2026-06-30

### Added
- **3 new passive liveness layers** (11–13): Replay Detection (dHash), LBP Texture (entropy), Boundary Detection (edge gradient)
- Liveness engine now runs 13 layers total (was 10)
- Canvas reuse optimization for skin ROI extraction
- Professional repository documentation (README, ARCHITECTURE, CHANGELOG)

### Fixed
- **Histogram consistency** — threshold too tight (0.0001→0.001), degradation too aggressive (0.15→0.08)
- **Depth geometry** — std threshold too strict (0.001→0.003), rejected real faces with subtle depth
- **rPPG comment** — corrected misleading "48-180 BPM heartbeat" to accurate "pulse-like oscillations"
- **Admin kiosk lock** — removed accidental admin-side kiosk activation in `startSessionActual`
- **Settings app blocking** — removed Settings from `ESSENTIAL_APPS` whitelist
- **Face descriptor prop** — `storedDescriptor` no longer falls back to `faceImage` string
- **WhitelistManager** — AccessibilityService now uses `WhitelistManager.isAllowed()` instead of raw `GlobalState` check
- **Firestore rules** — added `buddyIds` validation, buddy join path, buddy auto-end path

### Changed
- Score weights rebalanced across 13 layers (was 10)
- Replay detection weight: 0.20 (highest — catches video loop attacks)
- LBP texture weight: 0.15 (catches smooth-surface spoof)

## [1.0.0] — 2026-06-28

### Initial Release
- Dual-device Admin/Buddy architecture
- 10-layer passive liveness engine
- Multi-pose face registration (3 poses, 12 samples)
- Dual-metric identity matching (cosine + euclidean)
- Android kiosk mode with AccessibilityService
- Firestore real-time sync with security rules
- Temporal consensus state machine

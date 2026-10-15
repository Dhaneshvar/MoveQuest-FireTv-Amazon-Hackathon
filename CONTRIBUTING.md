# Contributing to MoveQuest

Thanks for helping improve MoveQuest. The project has two Android apps and a small shared TypeScript package:

- `apps/tv` — React Native TV interface and native Android camera-stream/inference integration.
- `apps/phone` — Android companion that streams camera frames to the TV over local Wi‑Fi.
- `packages/game-kit` — shared exercise scoring helpers and types.

## Development setup

Install Node.js, Android Studio, Android SDK Platform Tools, and the Android SDK/NDK versions required by the Gradle project. Enable USB debugging on a phone and ADB debugging on a Fire TV or Android TV emulator when testing on-device. See the root [README](README.md) for Android Studio, emulator, and device setup.

Install dependencies from each app directory:

```powershell
cd apps/tv
npm ci
cd ../phone
npm ci
```

## Before submitting a change

- Keep TV navigation usable with D-pad focus and Select; make focus visible and provide accessibility labels for interactive controls.
- Keep camera frames and inference local. Do not add uploads, analytics, or identity recognition without an explicit product/privacy review.
- Test the affected app with TypeScript (`npx tsc --noEmit` from its app directory) and build the relevant Android variant. Camera streaming and performance should be checked on real hardware where possible; emulators do not reproduce the phone-camera-to-TV workflow.
- For UI or navigation changes, verify focus order, Back behavior, and legibility from a couch-distance viewing position.
- Avoid committing generated build outputs, APKs, local SDK paths, signing keys, or camera footage. These are excluded by `.gitignore`.

## Branches and commits

Use a short descriptive branch name, for example `fix/tv-focus-order` or `feat/freeze-dance-rounds`. Keep commits focused and use a clear imperative subject, such as:

- `Add accessible labels to workout controls`
- `Improve MJPEG reconnect handling`
- `Document Android TV emulator setup`

Open a pull request with a short summary, test results, and any device/model limitations. Include screenshots or a short demo clip for visible UI changes, but do not include footage containing identifiable people unless they have consented.

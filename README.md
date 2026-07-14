# Vencord: Fake Voice Status

FakeVoiceStatus adds a native-looking user-panel toggle that reports you as muted and deafened without changing your local microphone, headphones, or camera state.

## What it does

- Reports `self_mute` and `self_deaf` as enabled while the toggle is active.
- Leaves local microphone input and audio output unchanged.
- Preserves the real `self_video` value in every rewritten voice-state update.
- Restores the real voice state before removing its gateway hook.
- Reconnects safely after Discord replaces or reconnects the gateway socket.
- Fails closed if a safe gateway hook cannot be installed, so the button never claims to be active when it is not.

The slash on the button turns red while the fake state is active. Click it again to restore the voice state Discord should actually receive.

## Screenshots

| Enabled | Disabled |
| --- | --- |
| ![Fake voice status enabled](assets/enabled-microphone.png) | ![Fake voice status disabled](assets/disabled-microphone.png) |

## Install

This repository is the complete Vencord userplugin folder.

1. Clone or copy the repository directly to `src/userplugins/fakeVoiceStatus` inside a Vencord checkout.
2. From the Vencord root, run `pnpm build`.
3. Inject or reinstall that Vencord build using your normal development workflow.
4. Restart Discord, then enable **FakeVoiceStatus** in Settings > Vencord > Plugins.

## How it works

The plugin patches only the current Discord gateway socket's voice-state send path, and only while the fake state is active. Outgoing voice-state opcode `4` payloads keep their guild, channel, and real camera state while mute and deafen are reported as enabled.

When the toggle is disabled or the plugin stops, FakeVoiceStatus first sends the real mute, deafen, and camera values, then restores the original socket method. A `CONNECTION_OPEN` listener safely re-establishes the patch and resynchronizes the state after a gateway reconnect.

The observer watches Discord's app root, while button discovery is restricted to the user-panel selector. Every injected button and observer is removed during cleanup.

## Privacy and scope

- No external requests or update checks.
- No token, cookie, message, or local-storage access.
- No global `WebSocket.prototype` patch.
- No mouse, keyboard, or clipboard automation.
- The plugin changes the voice state reported to Discord. It does not alter local device controls.

## Compatibility notes

Discord's internal gateway and user-panel structure can change. If the button no longer appears or voice-state updates stop working after a Discord release, update Vencord and rebuild before reporting an issue.

## Project details

- Plugin: `FakeVoiceStatus`
- Author: `saintordevil`
- License: GPL-3.0-or-later

## License

Licensed under the [GNU General Public License v3.0 or later](LICENSE).

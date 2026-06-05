# Vencord: Fake Voice Status

Discord voice-status control for Vencord: show yourself as muted and deafened while your local microphone and audio stay unchanged.

FakeVoiceStatus adds a native-looking button to Discord's user panel. When enabled, it reports a muted and deafened voice state to Discord while leaving your real local input and output behavior alone.

## Core Behavior

| Feature | What it does | How |
|---|---|---|
| **Fake Mute and Deafen** | Shows you as muted and deafened to others | Sends voice-state updates with `self_mute` and `self_deaf` enabled |
| **Local Audio Preserved** | Keeps your real microphone and headset behavior unchanged | Reads local media state only when restoring the real voice state |
| **User-Panel Button** | Adds a button beside Discord's voice controls | Uses Discord's own microphone button styling |
| **Native Control Placement** | Keeps Discord's real input and output dropdowns on the real controls | Inserts after the headset output picker when Discord exposes one |
| **No Visible Settings** | Uses one direct toggle instead of extra options | Stores only the hidden active state for cleanup |

## Requirements

- A working [Vencord](https://vencord.dev) development setup
- Discord desktop
- `pnpm`, as used by Vencord

## Install

1. Set up [Vencord](https://vencord.dev) if you have not already.
2. Copy the `fakeVoiceStatus` folder into your Vencord `src/userplugins/` directory.
3. Rebuild Vencord:

```bash
pnpm build
```

4. Enable **FakeVoiceStatus** in Discord Settings > Vencord > Plugins.

## Usage

Join or switch to a voice channel, then click the fake voice-status button in the bottom-left user panel.

When inactive, the slash uses Discord's normal icon color. When active, the slash turns red. Click the button again to restore your real voice state.

## Screenshots

| Enabled (Fake deafened) | Disabled (Not fake deafened) |
|---|---|
| ![Enabled fake deafened microphone state](assets/enabled-microphone.png) | ![Disabled not fake deafened microphone state](assets/disabled-microphone.png) |

## How It Works

FakeVoiceStatus hooks the current Discord gateway socket while the plugin is enabled. It only rewrites outgoing voice-state opcode `4` payloads while the fake status is active.

The plugin does not patch `WebSocket.prototype`, does not add global keybind listeners, and does not use external update checks. The socket patch is restored when the plugin stops.

## Technical Details

- Plugin name: `FakeVoiceStatus`
- Author: `saint`
- Uses Vencord's `definePlugin`
- Uses a hidden `fakeActive` setting for cleanup across restarts
- Uses a `MutationObserver` to add the user-panel button
- Clones Discord's native microphone button contents for visual consistency
- Uses CSS to draw the slash overlay and make it red while active
- Does not call external network endpoints
- Does not read tokens, cookies, local storage, or message content

## Notes

- This plugin changes the voice state Discord receives, not your local device state
- Discord internals can change, so the gateway or user-panel button logic may need updates after Discord releases
- Disable the plugin from Vencord's plugin list to remove the button and restore the real voice state

## License

MIT

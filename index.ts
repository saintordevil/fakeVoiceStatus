import "./style.css";

import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { findStoreLazy } from "@webpack";
import { ChannelStore, MediaEngineStore, SelectedChannelStore, UserStore, VoiceStateStore } from "@webpack/common";

const GatewayConnectionStore = findStoreLazy("GatewayConnectionStore") as {
    getSocket?: () => GatewaySocket | undefined;
};

const logger = new Logger("FakeVoiceStatus", "#7bd88f");

const BUTTON_MARKER = "data-vc-fake-voice-status-button";
const BUTTON_CLASS = "vc-fake-voice-status-button";

interface VoiceStateRequest {
    guildId?: string | null;
    guild_id?: string | null;
    channelId?: string | null;
    channel_id?: string | null;
    selfMute?: boolean;
    self_mute?: boolean;
    selfDeaf?: boolean;
    self_deaf?: boolean;
}

interface GatewayVoiceStatePayload {
    guild_id: string | null;
    channel_id: string | null;
    self_mute: boolean;
    self_deaf: boolean;
    [key: string]: unknown;
}

interface GatewaySocket {
    send?: (op: number, payload: GatewayVoiceStatePayload) => void;
}

type RestorePatch = () => void;

const settings = definePluginSettings({
    fakeActive: {
        type: OptionType.BOOLEAN,
        description: "Current fake voice-state toggle.",
        default: false,
        hidden: true,
    },
});

let panelObserver: MutationObserver | null = null;
let pluginRunning = false;
let refreshQueued = false;
let refreshFrame: number | null = null;
let patchedSocket: GatewaySocket | null = null;
let restoreSocketPatch: RestorePatch | null = null;

function readBool(value: unknown, fallback: boolean): boolean {
    return typeof value === "boolean" ? value : fallback;
}

function isFakeActive(): boolean {
    return readBool(settings.store.fakeActive, false);
}

function getGatewaySocket(): GatewaySocket | null {
    try {
        return GatewayConnectionStore?.getSocket?.() ?? null;
    } catch (e) {
        logger.warn("could not read gateway socket", e);
        return null;
    }
}

function getActualSelfMute(): boolean {
    try {
        return Boolean(
            MediaEngineStore?.isSelfMute?.() ??
            (MediaEngineStore as any)?.getSelfMute?.() ??
            false
        );
    } catch {
        return false;
    }
}

function getActualSelfDeaf(): boolean {
    try {
        return Boolean(
            MediaEngineStore?.isSelfDeaf?.() ??
            (MediaEngineStore as any)?.getSelfDeaf?.() ??
            false
        );
    } catch {
        return false;
    }
}

function getCurrentVoiceTarget(): Pick<GatewayVoiceStatePayload, "guild_id" | "channel_id"> | null {
    const channelId = SelectedChannelStore?.getVoiceChannelId?.() ?? null;
    if (!channelId) return null;

    const currentUserId = UserStore?.getCurrentUser?.()?.id;
    const voiceState = currentUserId ? VoiceStateStore?.getVoiceStateForUser?.(currentUserId) : null;
    const channel = ChannelStore?.getChannel?.(channelId) as { guild_id?: string; guildId?: string; } | null;

    return {
        guild_id: voiceState?.guildId ?? channel?.guild_id ?? channel?.guildId ?? null,
        channel_id: voiceState?.channelId ?? channelId,
    };
}

function buildPayload(request: VoiceStateRequest, fake: boolean): GatewayVoiceStatePayload {
    const actualMute = getActualSelfMute();
    const actualDeaf = getActualSelfDeaf();
    return {
        ...request,
        guild_id: request.guild_id ?? request.guildId ?? null,
        channel_id: request.channel_id ?? request.channelId ?? null,
        self_mute: fake ? true : actualMute,
        self_deaf: fake ? true : actualDeaf,
    };
}

function sendVoiceState(payload: GatewayVoiceStatePayload): boolean {
    const socket = getGatewaySocket();
    if (typeof socket?.send !== "function") return false;

    try {
        socket.send(4, payload);
        return true;
    } catch (e) {
        logger.warn("failed to send voice state", e);
        return false;
    }
}

function syncCurrentVoiceState(fake: boolean): boolean {
    const target = getCurrentVoiceTarget();
    if (!target) return false;

    return sendVoiceState(buildPayload(target, fake));
}

function installSocketPatch(): void {
    try {
        const socket = getGatewaySocket();
        if (!socket || typeof socket.send !== "function") return;
        if (restoreSocketPatch && patchedSocket === socket) return;

        restoreSocketPatch?.();

        const original = socket.send;
        const wrapped = function (this: GatewaySocket, op: number, payload: GatewayVoiceStatePayload) {
            if (op !== 4 || !isFakeActive() || !payload || typeof payload !== "object") {
                return original.call(this, op, payload);
            }

            const isLeavingVoice = (payload.channel_id ?? payload.channelId ?? null) == null;
            if (isLeavingVoice) return original.call(this, op, payload);

            return original.call(this, op, buildPayload(payload, true));
        };

        socket.send = wrapped;
        patchedSocket = socket;
        restoreSocketPatch = () => {
            if (socket.send === wrapped) socket.send = original;
            if (patchedSocket === socket) patchedSocket = null;
            restoreSocketPatch = null;
        };
    } catch (e) {
        logger.warn("gateway send hook unavailable", e);
        patchedSocket = null;
        restoreSocketPatch = null;
    }
}

function setFakeActive(active: boolean, reason: string): void {
    settings.store.fakeActive = active;
    if (active) installSocketPatch();

    const synced = syncCurrentVoiceState(active);
    updateButton();

    if (!synced) {
        logger.info(active
            ? `enabled, waiting for a voice channel (${reason})`
            : `disabled (${reason})`
        );
    }
}

function resyncIfActive(reason: string): void {
    if (!isFakeActive()) return;
    installSocketPatch();
    syncCurrentVoiceState(true);
    updateButton();
    logger.info(`resynced (${reason})`);
}

function normalizeLabel(button: HTMLButtonElement): string {
    return `${button.getAttribute("aria-label") ?? ""} ${button.title ?? ""}`.toLowerCase();
}

function isMuteButton(button: HTMLButtonElement): boolean {
    const label = normalizeLabel(button);
    return /\b(un)?mute\b/.test(label) && !label.includes("server");
}

function isDeafenButton(button: HTMLButtonElement): boolean {
    const label = normalizeLabel(button);
    return label.includes("deafen") || label.includes("undeafen");
}

function isSettingsButton(button: HTMLButtonElement): boolean {
    return normalizeLabel(button).includes("settings");
}

function isOutputPickerButton(button: HTMLButtonElement): boolean {
    const label = normalizeLabel(button);
    return label.includes("output") || label.includes("speaker") || label.includes("device");
}

function findDeafenInsertTarget(parent: HTMLElement, deafenButton: HTMLButtonElement): HTMLButtonElement {
    const siblingButtons = Array.from(parent.querySelectorAll<HTMLButtonElement>("button[aria-label]"));
    const deafenIndex = siblingButtons.indexOf(deafenButton);
    if (deafenIndex === -1) return deafenButton;

    for (const button of siblingButtons.slice(deafenIndex + 1)) {
        if (button.hasAttribute(BUTTON_MARKER)) continue;
        if (isMuteButton(button) || isDeafenButton(button) || isSettingsButton(button)) break;
        if (isOutputPickerButton(button)) return button;
        break;
    }

    return deafenButton;
}

function findAudioControls(): { parent: HTMLElement; source: HTMLButtonElement; insertAfter: HTMLButtonElement; } | null {
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("button[aria-label]"));

    for (const button of buttons) {
        const parent = button.parentElement;
        if (!parent || parent.querySelector<HTMLButtonElement>(`button[${BUTTON_MARKER}]`)) continue;

        const siblingButtons = Array.from(parent.querySelectorAll<HTMLButtonElement>("button[aria-label]"));
        const deafenButton = siblingButtons.find(isDeafenButton);
        const muteButton = siblingButtons.find(isMuteButton);

        if (deafenButton && muteButton) {
            return {
                parent,
                source: muteButton,
                insertAfter: findDeafenInsertTarget(parent, deafenButton),
            };
        }
    }

    return null;
}

function getButtonLabel(): string {
    return isFakeActive()
        ? "Disable fake mute and deafen"
        : "Enable fake mute and deafen";
}

function updateButton(): void {
    const button = document.querySelector<HTMLButtonElement>(`button[${BUTTON_MARKER}]`);
    if (!button) return;

    const active = isFakeActive();
    button.setAttribute("aria-label", getButtonLabel());
    button.setAttribute("aria-pressed", String(active));
    button.title = getButtonLabel();
}

function ensureButton(): void {
    if (!pluginRunning) return;

    const existing = document.querySelector<HTMLButtonElement>(`button[${BUTTON_MARKER}]`);
    if (existing) {
        updateButton();
        return;
    }

    const controls = findAudioControls();
    if (!controls) return;

    const button = document.createElement("button");
    button.type = "button";
    button.className = `${controls.source.className} ${BUTTON_CLASS}`;
    button.setAttribute(BUTTON_MARKER, "true");
    button.appendChild(cloneButtonContents(controls.source));
    button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        setFakeActive(!isFakeActive(), "button");
    });

    if (!controls.insertAfter.parentElement) return;
    controls.insertAfter.insertAdjacentElement("afterend", button);
    updateButton();
}

function cloneButtonContents(source: HTMLButtonElement): DocumentFragment {
    const fragment = document.createDocumentFragment();

    for (const child of Array.from(source.childNodes)) {
        fragment.appendChild(child.cloneNode(true));
    }

    if (!fragment.childNodes.length) throw new Error("Discord mute button contents not found");

    for (const element of Array.from(fragment.querySelectorAll<HTMLElement>("[id], [aria-describedby]"))) {
        element.removeAttribute("id");
        element.removeAttribute("aria-describedby");
    }

    return fragment;
}

function queueButtonRefresh(): void {
    if (!pluginRunning) return;
    if (refreshQueued) return;
    refreshQueued = true;
    refreshFrame = requestAnimationFrame(() => {
        refreshFrame = null;
        refreshQueued = false;
        try {
            ensureButton();
        } catch (e) {
            logger.warn("button refresh failed", e);
        }
    });
}

function startButtonObserver(): void {
    if (panelObserver) return;
    if (!document.body) return;

    queueButtonRefresh();
    panelObserver = new MutationObserver(queueButtonRefresh);
    panelObserver.observe(document.body, { childList: true, subtree: true });
}

function stopButtonObserver(): void {
    if (refreshFrame != null) {
        cancelAnimationFrame(refreshFrame);
        refreshFrame = null;
    }
    refreshQueued = false;
    panelObserver?.disconnect();
    panelObserver = null;
    document.querySelector<HTMLButtonElement>(`button[${BUTTON_MARKER}]`)?.remove();
}

export default definePlugin({
    name: "FakeVoiceStatus",
    description: "Adds a user-panel button that shows you as muted and deafened to others without changing local audio.",
    authors: [],

    settings,

    start() {
        pluginRunning = true;
        try {
            installSocketPatch();
            startButtonObserver();
            if (isFakeActive()) resyncIfActive("plugin start");
        } catch (e) {
            logger.warn("startup recovered after a non-fatal error", e);
        }
        logger.info("started");
    },

    stop() {
        try {
            if (isFakeActive()) syncCurrentVoiceState(false);
            settings.store.fakeActive = false;
        } catch (e) {
            logger.warn("stop sync failed", e);
        }
        pluginRunning = false;
        try {
            restoreSocketPatch?.();
        } catch (e) {
            logger.warn("gateway send hook restore failed", e);
        }
        stopButtonObserver();
        logger.info("stopped");
    },
});

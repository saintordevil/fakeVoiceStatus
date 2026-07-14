/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

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
const PANELS_SELECTOR = '[class^="panels_"], [class*=" panels_"]';
const SVG_NS = "http://www.w3.org/2000/svg";

interface VoiceStateRequest {
    guildId?: string | null;
    guild_id?: string | null;
    channelId?: string | null;
    channel_id?: string | null;
    selfMute?: boolean;
    self_mute?: boolean;
    selfDeaf?: boolean;
    self_deaf?: boolean;
    selfVideo?: boolean;
    self_video?: boolean;
}

interface GatewayVoiceStatePayload {
    guild_id: string | null;
    channel_id: string | null;
    self_mute: boolean;
    self_deaf: boolean;
    self_video: boolean;
    [key: string]: unknown;
}

interface GatewaySocket {
    send?: (op: number, payload: GatewayVoiceStatePayload) => void;
}

type RestorePatch = () => void;
type VoiceSyncResult = "sent" | "not-connected" | "failed";

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

function getActualSelfVideo(): boolean {
    try {
        return Boolean(MediaEngineStore?.isVideoEnabled?.() ?? false);
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
        self_video: readBool(request.self_video ?? request.selfVideo, getActualSelfVideo()),
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

function syncCurrentVoiceState(fake: boolean): VoiceSyncResult {
    try {
        const target = getCurrentVoiceTarget();
        if (!target) return "not-connected";

        return sendVoiceState(buildPayload(target, fake)) ? "sent" : "failed";
    } catch (e) {
        logger.warn("could not read the current voice state", e);
        return "failed";
    }
}

function installSocketPatch(): boolean {
    try {
        const socket = getGatewaySocket();
        if (!socket || typeof socket.send !== "function") return false;
        if (restoreSocketPatch && patchedSocket === socket) return true;

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
        return true;
    } catch (e) {
        logger.warn("gateway send hook unavailable", e);
        patchedSocket = null;
        restoreSocketPatch = null;
        return false;
    }
}

function restoreSocketHook(reason: string): void {
    try {
        restoreSocketPatch?.();
    } catch (e) {
        logger.warn(`gateway send hook restore failed (${reason})`, e);
        patchedSocket = null;
        restoreSocketPatch = null;
    }
}

function setFakeActive(active: boolean, reason: string): void {
    if (active && !installSocketPatch()) {
        settings.store.fakeActive = false;
        updateButton();
        logger.warn(`could not enable because the gateway hook is unavailable (${reason})`);
        return;
    }

    settings.store.fakeActive = active;

    const syncResult = syncCurrentVoiceState(active);
    if (!active) restoreSocketHook(reason);
    updateButton();

    if (syncResult === "sent") {
        logger.info(active
            ? `enabled and synced (${reason})`
            : `disabled and synced (${reason})`
        );
    } else if (syncResult === "not-connected") {
        logger.info(active
            ? `enabled, waiting for a voice channel (${reason})`
            : `disabled (${reason})`
        );
    } else {
        logger.warn(active
            ? `enabled, but the current voice state could not be synced (${reason})`
            : `disabled, but the current voice state could not be restored (${reason})`
        );
    }
}

function resyncIfActive(reason: string): void {
    if (!isFakeActive()) return;
    if (!installSocketPatch()) {
        settings.store.fakeActive = false;
        updateButton();
        logger.warn(`saved active state was reset because the gateway hook is unavailable (${reason})`);
        return;
    }

    const syncResult = syncCurrentVoiceState(true);
    updateButton();
    if (syncResult === "failed") logger.warn(`could not resync the current voice state (${reason})`);
    else logger.info(syncResult === "sent" ? `resynced (${reason})` : `waiting for a voice channel (${reason})`);
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
    const panels = Array.from(document.querySelectorAll<HTMLElement>(PANELS_SELECTOR));

    for (const panel of panels) {
        const buttons = Array.from(panel.querySelectorAll<HTMLButtonElement>("button[aria-label]"))
            .filter(button => !button.hasAttribute(BUTTON_MARKER));

        for (const button of buttons) {
            const parent = button.parentElement;
            if (!parent) continue;

            const siblingButtons = Array.from(parent.querySelectorAll<HTMLButtonElement>("button[aria-label]"))
                .filter(sibling => !sibling.hasAttribute(BUTTON_MARKER));
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
    }

    return null;
}

function getButtonLabel(): string {
    return isFakeActive()
        ? "Disable fake mute and deafen"
        : "Enable fake mute and deafen";
}

function updateButton(): void {
    const active = isFakeActive();
    const label = getButtonLabel();

    for (const button of document.querySelectorAll<HTMLButtonElement>(`button[${BUTTON_MARKER}]`)) {
        button.setAttribute("aria-label", label);
        button.setAttribute("aria-pressed", String(active));
        button.title = label;

        const slash = button.querySelector<SVGPathElement>(".vc-fake-voice-status-icon-slash");
        slash?.setAttribute("stroke", active ? "var(--status-danger, #f23f43)" : "currentColor");
    }
}

function ensureButton(): void {
    if (!pluginRunning) return;

    const controls = findAudioControls();
    if (!controls) return;

    const existing = controls.parent.querySelector<HTMLButtonElement>(`button[${BUTTON_MARKER}]`);
    if (existing) {
        updateButton();
        return;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = `${controls.source.className} ${BUTTON_CLASS}`;
    button.setAttribute(BUTTON_MARKER, "true");
    button.appendChild(createFakeVoiceIcon());
    button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        setFakeActive(!isFakeActive(), "button");
    });

    if (!controls.insertAfter.parentElement) return;
    controls.insertAfter.insertAdjacentElement("afterend", button);
    updateButton();
}

function createFakeVoiceIcon(): SVGSVGElement {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "vc-fake-voice-status-icon");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("role", "img");
    svg.setAttribute("width", "20");
    svg.setAttribute("height", "20");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2.4");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");

    const micBody = document.createElementNS(SVG_NS, "path");
    micBody.setAttribute("d", "M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z");

    const micStand = document.createElementNS(SVG_NS, "path");
    micStand.setAttribute("d", "M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8");

    const slash = document.createElementNS(SVG_NS, "path");
    slash.setAttribute("class", "vc-fake-voice-status-icon-slash");
    slash.setAttribute("d", "M4 4l16 16");

    svg.append(micBody, micStand, slash);
    return svg;
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
    const observerRoot = document.getElementById("app-mount") ?? document.body;
    if (!observerRoot) return;

    queueButtonRefresh();
    panelObserver = new MutationObserver(queueButtonRefresh);
    panelObserver.observe(observerRoot, { childList: true, subtree: true });
}

function stopButtonObserver(): void {
    if (refreshFrame != null) {
        cancelAnimationFrame(refreshFrame);
        refreshFrame = null;
    }
    refreshQueued = false;
    panelObserver?.disconnect();
    panelObserver = null;
    document.querySelectorAll<HTMLButtonElement>(`button[${BUTTON_MARKER}]`).forEach(button => button.remove());
}

export default definePlugin({
    name: "FakeVoiceStatus",
    description: "Adds a user-panel button that shows you as muted and deafened to others without changing local audio.",
    authors: [{
        name: "saintordevil",
        id: 0n,
    }],

    settings,

    flux: {
        CONNECTION_OPEN() {
            resyncIfActive("gateway connection open");
        },
    },

    start() {
        pluginRunning = true;
        try {
            startButtonObserver();
        } catch (e) {
            logger.warn("user-panel control failed to start", e);
        }
        if (isFakeActive()) resyncIfActive("plugin start");
        logger.info("started");
    },

    stop() {
        const wasActive = isFakeActive();
        settings.store.fakeActive = false;
        try {
            if (wasActive && syncCurrentVoiceState(false) === "failed") {
                logger.warn("could not restore the current voice state during stop");
            }
        } catch (e) {
            logger.warn("stop sync failed", e);
        }
        pluginRunning = false;
        restoreSocketHook("plugin stop");
        stopButtonObserver();
        logger.info("stopped");
    },
});

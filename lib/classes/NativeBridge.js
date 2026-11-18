import { world, system } from "@minecraft/server";

export class NativeBridge {
    /** @type {Map<string, { signal: any, callback: Function }>} */
    static #subscriptions = new Map();

    /**
     * Verifica se il nome corrisponde a un evento nativo di Minecraft (before: o after:).
     * @param {string} eventName
     * @returns {{ phase: "beforeEvents"|"afterEvents", nativeName: string, isBefore: boolean } | null}
     */
    static parseNativeName(eventName) {
        const match = /^(before|after):([a-zA-Z0-9_]+)$/.exec(eventName);
        if (!match) return null;
        return {
            phase: match[1] === "before" ? "beforeEvents" : "afterEvents",
            nativeName: match[2],
            isBefore: match[1] === "before"
        };
    }

    /**
     * Attiva la sottoscrizione nativa se non ancora presente.
     * @param {string} eventName
     * @param {(rawEvent: any, isBefore: boolean) => void} dispatchFn
     * @returns {boolean} True se è un evento nativo valido
     */
    static bind(eventName, dispatchFn) {
        const parsed = this.parseNativeName(eventName);
        if (!parsed) return false;
        if (this.#subscriptions.has(eventName)) return true;

        const signal = world[parsed.phase]?.[parsed.nativeName] ?? system[parsed.phase]?.[parsed.nativeName];
        if (!signal || typeof signal.subscribe !== "function") {
            throw new Error(`[EventsManager] Evento nativo sconosciuto: '${eventName}'`);
        }

        const callback = (rawEvent) => dispatchFn(rawEvent, parsed.isBefore);
        signal.subscribe(callback);
        this.#subscriptions.set(eventName, { signal, callback });
        return true;
    }

    /**
     * Rimuove la sottoscrizione nativa quando non ci sono più listener.
     * @param {string} eventName
     */
    static unbind(eventName) {
        const sub = this.#subscriptions.get(eventName);
        if (!sub) return;
        try {
            sub.signal.unsubscribe(sub.callback);
        } catch (_) {
            // Ignora se già rimosso
        }
        this.#subscriptions.delete(eventName);
    }
}

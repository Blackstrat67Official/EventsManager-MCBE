import { system } from "@minecraft/server";
import { EventContext } from "./EventContext.js";
import { NativeBridge } from "./NativeBridge.js";

export const Priority = Object.freeze({
    HIGHEST: 100,
    HIGH: 75,
    NORMAL: 50,
    LOW: 25,
    LOWEST: 0,
    MONITOR: -1
});

export class EventsManager {
    /**
     * Namespace esplicito per le sottoclassi.
     * Se omesso nelle sottoclassi, viene dedotto automaticamente dal nome della classe in minuscolo.
     * @type {string|null}
     */
    static namespace = null;

    /** @type {Map<string, Array<Object>>} */
    static #listeners = new Map();

    /** @type {Map<string, Array<(ctx: EventContext) => boolean|void>>} */
    static #middlewares = new Map();

    /** @type {number} */
    static #nextId = 1;

    /**
     * @param {Object} [defaultOptions] Opzioni predefinite applicate ai listener registrati tramite questa istanza
     */
    constructor(defaultOptions = {}) {
        this.defaultOptions = defaultOptions;
    }

    // ─── Risoluzione Namespace & Nomi Evento ──────────────────────────────────

    /**
     * Restituisce il namespace della classe corrente (null per EventsManager base).
     * @returns {string|null}
     */
    static getNamespace() {
        if (Object.prototype.hasOwnProperty.call(this, "namespace")) {
            return this.namespace;
        }
        return this === EventsManager ? null : this.name.toLowerCase();
    }

    /**
     * Risolve il nome dell'evento applicando il namespace della sottoclasse se necessario.
     * - "transfer" su Economy -> "economy:transfer"
     * - "*" su Economy -> "economy:*"
     * - "before:playerBreakBlock" -> "before:playerBreakBlock" (nativo)
     * - "police:arrest" -> "police:arrest" (già qualificato)
     * @param {string} eventName
     * @returns {{ fullName: string, localName: string, category: string|null }}
     */
    static resolveEventName(eventName) {
        const ns = this.getNamespace();

        // Eventi nativi Minecraft (before:... / after:...)
        if (/^(before|after):/.test(eventName)) {
            return { fullName: eventName, localName: eventName, category: ns };
        }

        // Evento già dotato di namespace esplicito (es. "economy:transfer" o "economy:*")
        if (eventName.includes(":")) {
            const [prefix, ...rest] = eventName.split(":");
            return {
                fullName: eventName,
                localName: rest.join(":"),
                category: prefix === "*" ? ns : prefix
            };
        }

        // Evento locale alla sottoclasse (es. Economy.on("transfer") -> "economy:transfer")
        if (ns) {
            return {
                fullName: `${ns}:${eventName}`,
                localName: eventName,
                category: ns
            };
        }

        return { fullName: eventName, localName: eventName, category: null };
    }

    // ─── API Statica (Registrazione, Middleware, Emissione) ───────────────────

    /**
     * Registra un middleware eseguito prima dei listener per questa categoria (o globalmente se chiamato su EventsManager).
     * Restituendo `false` il middleware blocca l'esecuzione dell'evento.
     * @param {(ctx: EventContext) => boolean|void} fn
     */
    static use(fn) {
        const key = this.getNamespace() ?? "*";
        if (!this.#middlewares.has(key)) this.#middlewares.set(key, []);
        this.#middlewares.get(key).push(fn);
        return () => {
            const list = this.#middlewares.get(key);
            if (!list) return;
            const idx = list.indexOf(fn);
            if (idx !== -1) list.splice(idx, 1);
        };
    }

    /**
     * Registra un listener su un evento della categoria corrente o su un evento nativo/globale.
     * @param {string} eventName
     * @param {(ctx: EventContext) => void} handler
     * @param {Object} [options]
     * @param {number} [options.priority=Priority.NORMAL]
     * @param {boolean} [options.ignoreCancelled=false]
     * @param {boolean} [options.once=false]
     * @param {(ctx: EventContext) => boolean} [options.filter]
     * @returns {() => void} Funzione per disiscrivere il listener
     */
    static on(eventName, handler, options = {}) {
        const { fullName } = this.resolveEventName(eventName);
        const ownerCategory = this.getNamespace() ?? "global";

        // Collega automaticamente gli eventi nativi di Minecraft in modalità Lazy
        NativeBridge.bind(fullName, (rawEvent, isBefore) => {
            this.#dispatch(fullName, {}, rawEvent, isBefore);
        });

        if (!this.#listeners.has(fullName)) {
            this.#listeners.set(fullName, []);
        }

        const entry = {
            id: this.#nextId++,
            eventName: fullName,
            ownerCategory,
            handler,
            priority: options.priority ?? Priority.NORMAL,
            ignoreCancelled: options.ignoreCancelled ?? false,
            once: options.once ?? false,
            filter: options.filter ?? null
        };

        const list = this.#listeners.get(fullName);
        list.push(entry);

        // Ordina: priorità più alta prima; MONITOR (-1) sempre per ultimo
        list.sort((a, b) => {
            if (a.priority === Priority.MONITOR && b.priority !== Priority.MONITOR) return 1;
            if (b.priority === Priority.MONITOR && a.priority !== Priority.MONITOR) return -1;
            return b.priority - a.priority;
        });

        return () => this.off(fullName, entry.id);
    }

    /**
     * Registra un listener che si auto-rimuove dopo la prima esecuzione valida.
     */
    static once(eventName, handler, options = {}) {
        return this.on(eventName, handler, { ...options, once: true });
    }

    /**
     * Rimuove un listener tramite ID o riferimento alla funzione handler.
     * @param {string} eventName
     * @param {number|Function} idOrHandler
     */
    static off(eventName, idOrHandler) {
        const { fullName } = this.resolveEventName(eventName);
        const list = this.#listeners.get(fullName);
        if (!list) return false;

        const idx = list.findIndex((item) =>
            typeof idOrHandler === "number" ? item.id === idOrHandler : item.handler === idOrHandler
        );
        if (idx === -1) return false;

        list.splice(idx, 1);
        if (list.length === 0) {
            this.#listeners.delete(fullName);
            NativeBridge.unbind(fullName);
        }
        return true;
    }

    /**
     * Rimuove tutti i listener registrati da questa specifica sottoclasse/categoria.
     */
    static clearCategory() {
        const targetCategory = this.getNamespace() ?? "global";
        for (const [fullName, list] of this.#listeners.entries()) {
            const remaining = list.filter((item) => item.ownerCategory !== targetCategory);
            if (remaining.length === 0) {
                this.#listeners.delete(fullName);
                NativeBridge.unbind(fullName);
            } else {
                this.#listeners.set(fullName, remaining);
            }
        }
    }

    /**
     * Emette un evento custom nella categoria della classe corrente (o globale).
     * @param {string} eventName
     * @param {Object} [data={}]
     * @param {Object} [options]
     * @param {boolean} [options.cancellable=true]
     * @returns {EventContext}
     */
    static emit(eventName, data = {}, options = {}) {
        const { fullName } = this.resolveEventName(eventName);
        return this.#dispatch(fullName, data, null, options.cancellable ?? true);
    }

    /**
     * Attende in modo asincrono (Promise) il verificarsi di un evento, con supporto a filtri e timeout in tick.
     * @param {string} eventName
     * @param {Object} [options]
     * @param {(ctx: EventContext) => boolean} [options.filter]
     * @param {number} [options.timeoutTicks]
     * @returns {Promise<EventContext|null>}
     */
    static waitFor(eventName, options = {}) {
        return new Promise((resolve) => {
            let timeoutId = null;
            const unsubscribe = this.on(eventName, (ctx) => {
                if (timeoutId !== null) system.clearRun(timeoutId);
                unsubscribe();
                resolve(ctx);
            }, {
                priority: options.priority ?? Priority.NORMAL,
                filter: options.filter
            });

            if (typeof options.timeoutTicks === "number" && options.timeoutTicks > 0) {
                timeoutId = system.runTimeout(() => {
                    unsubscribe();
                    resolve(null);
                }, options.timeoutTicks);
            }
        });
    }

    // ─── Motore Interno di Dispatch ───────────────────────────────────────────

    static #dispatch(fullName, data, rawEvent, cancellable) {
        const colonIdx = fullName.indexOf(":");
        const isNative = /^(before|after):/.test(fullName);
        const category = !isNative && colonIdx !== -1 ? fullName.slice(0, colonIdx) : null;
        const localName = !isNative && colonIdx !== -1 ? fullName.slice(colonIdx + 1) : fullName;

        const ctx = new EventContext({
            eventName: fullName,
            category,
            localName,
            data,
            raw: rawEvent,
            cancellable
        });

        // 1. Esegue i middleware globali e di categoria
        const applicableMiddlewares = [
            ...(this.#middlewares.get("*") ?? []),
            ...(category ? (this.#middlewares.get(category) ?? []) : [])
        ];
        for (const mw of applicableMiddlewares) {
            if (mw(ctx) === false) return ctx;
        }

        // 2. Raccoglie i listener esatti + wildcard ("economy:*" e "*")
        const matched = [
            ...(this.#listeners.get(fullName) ?? []),
            ...(category ? (this.#listeners.get(`${category}:*`) ?? []) : []),
            ...(this.#listeners.get("*") ?? [])
        ];

        if (matched.length === 0) return ctx;

        // Riordina l'unione di esatti + wildcard per priorità
        matched.sort((a, b) => {
            if (a.priority === Priority.MONITOR && b.priority !== Priority.MONITOR) return 1;
            if (b.priority === Priority.MONITOR && a.priority !== Priority.MONITOR) return -1;
            return b.priority - a.priority;
        });

        for (const entry of matched) {
            if (ctx.propagationStopped && entry.priority !== Priority.MONITOR) continue;
            if (entry.ignoreCancelled && ctx.cancelled) continue;

            if (entry.filter) {
                let passed = false;
                try {
                    passed = Boolean(entry.filter(ctx));
                } catch (err) {
                    console.error(`[EventsManager] Errore nel filter di '${entry.eventName}':`, err);
                }
                if (!passed) continue;
            }

            ctx._isMonitorPhase = entry.priority === Priority.MONITOR;
            try {
                entry.handler(ctx);
            } catch (err) {
                console.error(`[EventsManager] Errore nel listener #${entry.id} (${entry.ownerCategory}) su '${entry.eventName}':`, err);
            } finally {
                ctx._isMonitorPhase = false;
            }

            if (entry.once) {
                this.off(entry.eventName, entry.id);
            }
        }

        // 3. Esegue le azioni defer() fuori dal Read-Only Mode
        ctx._flushDeferred();
        return ctx;
    }

    // ─── API d'Istanza (delega alla classe mantenendo defaultOptions) ──────────

    on(eventName, handler, options = {}) {
        return this.constructor.on(eventName, handler, { ...this.defaultOptions, ...options });
    }

    once(eventName, handler, options = {}) {
        return this.constructor.once(eventName, handler, { ...this.defaultOptions, ...options });
    }

    off(eventName, idOrHandler) {
        return this.constructor.off(eventName, idOrHandler);
    }

    emit(eventName, data = {}, options = {}) {
        return this.constructor.emit(eventName, data, options);
    }

    waitFor(eventName, options = {}) {
        return this.constructor.waitFor(eventName, { ...this.defaultOptions, ...options });
    }
}

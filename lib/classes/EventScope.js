import { system } from "@minecraft/server";
import { EventsManager, Priority } from "./EventsManager.js";

export class EventScope {
    /** @type {Set<() => void>} */
    #cleanups = new Set();

    /** @type {Set<EventScope>} */
    #children = new Set();

    /** @type {Set<(reason: string) => void>} */
    #disposeListeners = new Set();

    /** @type {boolean} */
    #disposed = false;

    /** @type {number|null} */
    #ttlRunId = null;

    /**
     * @param {Object} [options]
     * @param {string} [options.name="anonymous"] Nome descrittivo dello scope (utile per debug)
     * @param {typeof EventsManager} [options.manager=EventsManager] Classe EventsManager (o sottoclasse come Economy) predefinita
     * @param {number} [options.ttlTicks] Durata massima in tick prima dell'auto-pulizia
     */
    constructor({ name = "anonymous", manager = EventsManager, ttlTicks } = {}) {
        this.name = name;
        this.defaultManager = manager;

        if (typeof ttlTicks === "number" && ttlTicks > 0) {
            this.#ttlRunId = system.runTimeout(() => {
                this.#ttlRunId = null;
                this.dispose("timeout");
            }, ttlTicks);
        }
    }

    /** @returns {boolean} */
    get isDisposed() {
        return this.#disposed;
    }

    /** @returns {number} Numero di listener/risorse attualmente attive nello scope */
    get size() {
        return this.#cleanups.size;
    }

    // ─── Factory Methods ──────────────────────────────────────────────────────

    /**
     * Crea uno scope legato a un giocatore: si auto-distrugge appena il giocatore esce dal server.
     * Salva subito `player.id` per evitare riferimenti a oggetti Player invalidati al disconnect.
     * @param {import("@minecraft/server").Player | string} player
     * @param {Object} [options]
     * @param {typeof EventsManager} [options.manager=EventsManager]
     * @param {number} [options.ttlTicks]
     * @returns {EventScope}
     */
    static forPlayer(player, options = {}) {
        const playerId = typeof player === "string" ? player : player.id;
        const playerName = typeof player === "string" ? player : (player.name ?? playerId);
        const scope = new EventScope({
            name: `player:${playerName}`,
            manager: options.manager ?? EventsManager,
            ttlTicks: options.ttlTicks
        });

        const unsubLeave = EventsManager.on("after:playerLeave", (ctx) => {
            if (ctx.playerId === playerId) {
                scope.dispose("playerLeave");
            }
        }, { priority: Priority.MONITOR });

        scope.#cleanups.add(unsubLeave);
        return scope;
    }

    /**
     * Crea uno scope legato a un'entità: si auto-distrugge quando l'entità viene rimossa dal mondo.
     * @param {import("@minecraft/server").Entity | string} entity
     * @param {Object} [options]
     * @param {typeof EventsManager} [options.manager=EventsManager]
     * @param {number} [options.ttlTicks]
     * @returns {EventScope}
     */
    static forEntity(entity, options = {}) {
        const entityId = typeof entity === "string" ? entity : entity.id;
        const scope = new EventScope({
            name: `entity:${entityId}`,
            manager: options.manager ?? EventsManager,
            ttlTicks: options.ttlTicks
        });

        const unsubRemove = EventsManager.on("after:entityRemove", (ctx) => {
            if (ctx.removedEntityId === entityId) {
                scope.dispose("entityRemove");
            }
        }, { priority: Priority.MONITOR });

        scope.#cleanups.add(unsubRemove);
        return scope;
    }

    /**
     * Crea uno scope temporaneo con scadenza automatica dopo N tick.
     * @param {number} ticks
     * @param {Object} [options]
     * @returns {EventScope}
     */
    static withTimeout(ticks, options = {}) {
        return new EventScope({
            name: options.name ?? `timeout:${ticks}t`,
            manager: options.manager ?? EventsManager,
            ttlTicks: ticks
        });
    }

    // ─── Registrazione Listener e Risorse ─────────────────────────────────────

    /**
     * Registra un listener tracciato da questo scope.
     * @param {string} eventName
     * @param {(ctx: import("./EventContext.js").EventContext) => void} handler
     * @param {Object} [options] Accetta tutte le opzioni di EventsManager.on più `manager` per override di categoria
     * @returns {() => void}
     */
    on(eventName, handler, options = {}) {
        if (this.#disposed) return () => {};

        const targetManager = options.manager ?? this.defaultManager;
        const rawUnsub = targetManager.on(eventName, handler, options);

        const trackedUnsub = () => {
            this.#cleanups.delete(trackedUnsub);
            rawUnsub();
        };

        this.#cleanups.add(trackedUnsub);
        return trackedUnsub;
    }

    /**
     * Registra un listener one-shot tracciato dallo scope.
     * Si rimuove automaticamente sia dopo l'esecuzione sia se lo scope viene chiuso prima.
     * @param {string} eventName
     * @param {(ctx: import("./EventContext.js").EventContext) => void} handler
     * @param {Object} [options]
     * @returns {() => void}
     */
    once(eventName, handler, options = {}) {
        if (this.#disposed) return () => {};

        let trackedUnsub = () => {};
        trackedUnsub = this.on(eventName, (ctx) => {
            trackedUnsub();
            handler(ctx);
        }, options);

        return trackedUnsub;
    }

    /**
     * Registra una funzione di pulizia custom (es. `() => system.clearRun(id)`) eseguita al dispose().
     * @param {() => void} cleanupFn
     * @returns {() => void}
     */
    add(cleanupFn) {
        if (this.#disposed) {
            try { cleanupFn(); } catch (_) {}
            return () => {};
        }

        const wrapper = () => {
            this.#cleanups.delete(wrapper);
            cleanupFn();
        };

        this.#cleanups.add(wrapper);
        return wrapper;
    }

    /**
     * Crea un sotto-scope figlio (es. singola fase di una quest): se il padre chiude, chiude anche il figlio.
     * @param {Object} [options]
     * @returns {EventScope}
     */
    child(options = {}) {
        const childScope = new EventScope({
            name: `${this.name}>${options.name ?? "child"}`,
            manager: options.manager ?? this.defaultManager,
            ttlTicks: options.ttlTicks
        });

        if (this.#disposed) {
            childScope.dispose("parentAlreadyDisposed");
            return childScope;
        }

        this.#children.add(childScope);
        childScope.onDispose(() => {
            this.#children.delete(childScope);
        });

        return childScope;
    }

    /**
     * Registra una callback invocata al momento della chiusura dello scope.
     * @param {(reason: string) => void} fn
     */
    onDispose(fn) {
        if (this.#disposed) {
            fn("alreadyDisposed");
            return;
        }
        this.#disposeListeners.add(fn);
    }

    /**
     * Rimuove tutti i listener, i sotto-scope e le risorse associate. Operazione idempotente.
     * @param {string} [reason="manual"]
     */
    dispose(reason = "manual") {
        if (this.#disposed) return;
        this.#disposed = true;

        if (this.#ttlRunId !== null) {
            system.clearRun(this.#ttlRunId);
            this.#ttlRunId = null;
        }

        for (const child of this.#children) {
            child.dispose(`parent:${reason}`);
        }
        this.#children.clear();

        for (const cleanup of Array.from(this.#cleanups)) {
            try {
                cleanup();
            } catch (err) {
                console.error(`[EventScope:${this.name}] Errore durante cleanup:`, err);
            }
        }
        this.#cleanups.clear();

        for (const listener of this.#disposeListeners) {
            try {
                listener(reason);
            } catch (err) {
                console.error(`[EventScope:${this.name}] Errore in onDispose:`, err);
            }
        }
        this.#disposeListeners.clear();
    }
}

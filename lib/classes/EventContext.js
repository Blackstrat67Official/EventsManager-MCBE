import { system } from "@minecraft/server";

export class EventContext {
    /**
     * @param {Object} params
     * @param {string} params.eventName Nome completo dell'evento (es. "economy:transfer")
     * @param {string|null} params.category Categoria/namespace (es. "economy")
     * @param {string} params.localName Nome locale dell'evento (es. "transfer")
     * @param {Object} [params.data] Payload custom dell'evento
     * @param {Object|null} [params.raw] Evento nativo di Minecraft (se presente)
     * @param {boolean} [params.cancellable=true] Se l'evento può essere annullato
     */
    constructor({ eventName, category = null, localName, data = {}, raw = null, cancellable = true }) {
        this.eventName = eventName;
        this.category = category;
        this.localName = localName;
        this.data = data;
        this.raw = raw;
        this.cancellable = cancellable;

        this.cancelled = false;
        this.cancelReason = null;
        this.cancelledBy = null;
        this.propagationStopped = false;
        this.timestamp = Date.now();

        /** @type {Array<() => void>} */
        this._deferredTasks = [];
        /** @type {boolean} */
        this._isMonitorPhase = false;

        return new Proxy(this, {
            get(target, prop, receiver) {
                if (prop in target) {
                    const val = Reflect.get(target, prop, receiver);
                    return typeof val === "function" ? val.bind(target) : val;
                }
                if (target.data && prop in target.data) {
                    return target.data[prop];
                }
                if (target.raw && prop in target.raw) {
                    const rawVal = target.raw[prop];
                    return typeof rawVal === "function" ? rawVal.bind(target.raw) : rawVal;
                }
                return undefined;
            },
            set(target, prop, value) {
                if (prop in target) {
                    target[prop] = value;
                    return true;
                }
                if (target.raw && prop in target.raw) {
                    target.raw[prop] = value;
                    return true;
                }
                target.data[prop] = value;
                return true;
            }
        });
    }

    /**
     * Annulla l'evento (se cancellabile e non in fase MONITOR).
     * @param {string} [reason=""] Motivo dell'annullamento
     * @param {string|null} [source=null] Modulo o categoria che ha bloccato l'evento
     */
    cancel(reason = "", source = null) {
        if (this._isMonitorPhase) {
            throw new Error(`[EventsManager] Impossibile annullare '${this.eventName}' in fase Priority.MONITOR (sola lettura).`);
        }
        if (!this.cancellable) {
            throw new Error(`[EventsManager] L'evento '${this.eventName}' non è cancellabile.`);
        }

        this.cancelled = true;
        this.cancelReason = reason;
        this.cancelledBy = source;

        if (this.raw && "cancel" in this.raw) {
            this.raw.cancel = true;
        }
    }

    /**
     * Interrompe l'esecuzione dei listener successivi a priorità inferiore.
     */
    stopPropagation() {
        this.propagationStopped = true;
    }

    /**
     * Pianifica un'azione nel prossimo tick scrivibile (risolve il Read-Only Mode dei beforeEvents).
     * @param {() => void} fn
     */
    defer(fn) {
        if (typeof fn === "function") {
            this._deferredTasks.push(fn);
        }
    }

    /**
     * Esegue tutte le task accodate con defer().
     * @internal
     */
    _flushDeferred() {
        if (this._deferredTasks.length === 0) return;
        const tasks = this._deferredTasks.splice(0);
        system.run(() => {
            for (const task of tasks) {
                try {
                    task();
                } catch (err) {
                    console.error(`[EventsManager] Errore in ctx.defer() su '${this.eventName}':`, err);
                }
            }
        });
    }
}

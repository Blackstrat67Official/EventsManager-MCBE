import { system } from "@minecraft/server";

export class Filters {
    /**
     * Estrae una chiave univoca dal contesto evento (di default l'ID del giocatore o entità coinvolta).
     * @param {import("./EventContext.js").EventContext} ctx
     * @param {(ctx: import("./EventContext.js").EventContext) => string} [keyFn]
     * @returns {string}
     */
    static resolveSubjectKey(ctx, keyFn) {
        if (typeof keyFn === "function") {
            return String(keyFn(ctx) ?? "global");
        }
        return String(
            ctx.player?.id ??
            ctx.sender?.id ??
            ctx.damagingEntity?.id ??
            ctx.source?.id ??
            ctx.entity?.id ??
            "global"
        );
    }

    // ─── Rate Limiting (Throttle & Debounce su Tick) ──────────────────────────

    /**
     * Filtro Throttle (anti-spam / cooldown): esegue subito il primo evento, poi blocca
     * gli eventi successivi per `ticks` tick per la stessa chiave (giocatore o globale).
     *
     * @param {number} ticks Numero minimo di tick tra due esecuzioni
     * @param {Object} [options]
     * @param {(ctx: import("./EventContext.js").EventContext) => string} [options.keyFn] Estrattore chiave (default: ID giocatore/entità)
     * @param {(ctx: import("./EventContext.js").EventContext, remainingTicks: number) => void} [options.onBlocked] Callback invocata quando l'evento viene filtrato per cooldown
     * @returns {(ctx: import("./EventContext.js").EventContext) => boolean}
     */
    static throttleTicks(ticks, options = {}) {
        /** @type {Map<string, number>} */
        const lastExecutedTick = new Map();
        const { keyFn, onBlocked } = options;

        return (ctx) => {
            const now = system.currentTick;
            const key = Filters.resolveSubjectKey(ctx, keyFn);
            const last = lastExecutedTick.get(key);

            if (last !== undefined && (now - last) < ticks) {
                if (typeof onBlocked === "function") {
                    onBlocked(ctx, ticks - (now - last));
                }
                return false;
            }

            // Pulizia periodica di chiavi scadute per evitare crescita infinita della Map
            if (lastExecutedTick.size > 256) {
                for (const [k, tick] of lastExecutedTick.entries()) {
                    if ((now - tick) >= ticks) lastExecutedTick.delete(k);
                }
            }

            lastExecutedTick.set(key, now);
            return true;
        };
    }

    /**
     * Avvolge un handler con Debounce: attende che trascorrano `ticks` tick senza nuovi eventi
     * per la stessa chiave prima di eseguire `handler` con l'ultimo `EventContext` ricevuto.
     *
     * @param {number} ticks Finestra di attesa in tick
     * @param {(ctx: import("./EventContext.js").EventContext) => void} handler
     * @param {Object} [options]
     * @param {(ctx: import("./EventContext.js").EventContext) => string} [options.keyFn]
     * @returns {(ctx: import("./EventContext.js").EventContext) => void}
     */
    static debounceHandler(ticks, handler, options = {}) {
        /** @type {Map<string, number>} */
        const pendingRuns = new Map();
        const { keyFn } = options;

        return (ctx) => {
            const key = Filters.resolveSubjectKey(ctx, keyFn);
            const existingRunId = pendingRuns.get(key);

            if (existingRunId !== undefined) {
                system.clearRun(existingRunId);
            }

            const runId = system.runTimeout(() => {
                pendingRuns.delete(key);
                handler(ctx);
            }, ticks);

            pendingRuns.set(key, runId);
        };
    }

    /**
     * Restituisce un descrittore di debounce utilizzabile anche come filtro o opzione dichiarativa.
     * @param {number} ticks
     * @param {Object} [options]
     * @param {(ctx: import("./EventContext.js").EventContext) => string} [options.keyFn]
     */
    static debounceTicks(ticks, options = {}) {
        const marker = () => true;
        marker._debounceConfig = { ticks, keyFn: options.keyFn };
        return marker;
    }

    // ─── Combinatori Logici ───────────────────────────────────────────────────

    /** @param {...(ctx: any) => boolean} predicates */
    static all(...predicates) {
        return (ctx) => predicates.every((fn) => Boolean(fn(ctx)));
    }

    /** @param {...(ctx: any) => boolean} predicates */
    static any(...predicates) {
        return (ctx) => predicates.some((fn) => Boolean(fn(ctx)));
    }

    /** @param {(ctx: any) => boolean} predicate */
    static not(predicate) {
        return (ctx) => !predicate(ctx);
    }

    // ─── Predicati Specifici Minecraft ────────────────────────────────────────

    /** Verifica che il giocatore/entità abbia un determinato tag */
    static hasTag(tag) {
        return (ctx) => {
            const actor = ctx.player ?? ctx.sender ?? ctx.entity ?? ctx.damagingEntity;
            return Boolean(actor?.hasTag?.(tag));
        };
    }

    /** Verifica che il giocatore/entità abbia almeno uno dei tag indicati */
    static hasAnyTag(...tags) {
        return (ctx) => {
            const actor = ctx.player ?? ctx.sender ?? ctx.entity ?? ctx.damagingEntity;
            return Boolean(actor && tags.some((t) => actor.hasTag?.(t)));
        };
    }

    /** Verifica la dimensione (es. "overworld", "minecraft:nether", "the_end") */
    static inDimension(dimensionId) {
        const normalized = dimensionId.includes(":") ? dimensionId : `minecraft:${dimensionId}`;
        return (ctx) => {
            const dim = ctx.dimension ?? ctx.player?.dimension ?? ctx.block?.dimension ?? ctx.entity?.dimension;
            return dim?.id === normalized;
        };
    }

    /** Verifica il typeId del blocco coinvolto */
    static blockType(...typeIds) {
        const set = new Set(typeIds.map((id) => (id.includes(":") ? id : `minecraft:${id}`)));
        return (ctx) => Boolean(ctx.block && set.has(ctx.block.typeId));
    }

    /** Verifica il typeId dell'item coinvolto */
    static itemType(...typeIds) {
        const set = new Set(typeIds.map((id) => (id.includes(":") ? id : `minecraft:${id}`)));
        return (ctx) => {
            const item = ctx.itemStack ?? ctx.item;
            return Boolean(item && set.has(item.typeId));
        };
    }

    /** Verifica il typeId dell'entità coinvolta */
    static entityType(...typeIds) {
        const set = new Set(typeIds.map((id) => (id.includes(":") ? id : `minecraft:${id}`)));
        return (ctx) => {
            const ent = ctx.entity ?? ctx.hurtEntity ?? ctx.damagingEntity;
            return Boolean(ent && set.has(ent.typeId));
        };
    }

    /** Verifica che l'evento avvenga entro `radius` blocchi da `center` ({ x, y, z }) */
    static inRadius(center, radius) {
        const rSq = radius * radius;
        return (ctx) => {
            const loc = ctx.block?.location ?? ctx.player?.location ?? ctx.entity?.location ?? ctx.location;
            if (!loc) return false;
            const dx = loc.x - center.x;
            const dy = loc.y - center.y;
            const dz = loc.z - center.z;
            return (dx * dx + dy * dy + dz * dz) <= rSq;
        };
    }
}

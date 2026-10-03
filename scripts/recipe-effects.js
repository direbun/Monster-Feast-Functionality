import { MODULE_ID, FEAST_ID, clone } from "./model.js";

export const LINKED_EFFECT_ACTION = "mffApplyRecipeEffects";
const queues = new Map();
const tiers = ["standard", "exceptional"];

export function snapshotEffect(effect) {
    if (effect?.documentName !== "ActiveEffect" || typeof effect.toObject !== "function") throw Error("Drop an Active Effect or an item containing effects.");
    const data = clone(effect.toObject());
    for (const key of ["_id", "_key", "_stats", "folder", "sort", "ownership"]) delete data[key];
    if (data.duration) {
        for (const key of ["startTime", "startRound", "startTurn", "combat"]) delete data.duration[key];
    }
    return {
        uuid: effect.uuid ?? "",
        originUuid: effect.parent?.uuid ?? data.origin ?? "",
        name: effect.name ?? data.name ?? data.label ?? "Linked effect",
        data
    };
}

export function validateLinkedEffects(recipe) {
    const config = recipe.mffEffects;
    if (config === undefined) return [];
    const errors = [];
    if (!config || typeof config !== "object" || Array.isArray(config)) return ["Linked effects must be an object."];
    for (const tier of tiers) {
        const effects = config[tier];
        if (effects === undefined) continue;
        if (!Array.isArray(effects) || effects.length > 20) {
            errors.push(tier + ": use at most 20 linked effects.");
            continue;
        }
        for (const effect of effects) {
            if (!effect || typeof effect.name !== "string" || !effect.name.trim() ||
                !effect.data || typeof effect.data !== "object" || Array.isArray(effect.data)) {
                errors.push(tier + ": invalid linked effect.");
                continue;
            }
            if (effect.data.changes !== undefined && !Array.isArray(effect.data.changes)) errors.push(tier + ": effect changes must be a list.");
            if (effect.data.flags !== undefined && (!effect.data.flags || typeof effect.data.flags !== "object" || Array.isArray(effect.data.flags))) errors.push(tier + ": invalid effect flags.");
        }
    }
    return errors;
}

export function selectedLinkedEffects(recipe, exceptional) {
    return recipe?.mffEffects?.[exceptional === true ? "exceptional" : "standard"] ?? [];
}

export function buildLinkedEffect(snapshot, recipe, exceptional, actor, context = {}) {
    const data = clone(snapshot.data);
    for (const key of ["_id", "_key", "_stats", "folder", "sort", "ownership"]) delete data[key];
    data.name = snapshot.name;
    data.disabled = false;
    data.transfer = false;
    data.origin = snapshot.originUuid || snapshot.uuid || actor.uuid;
    data.duration ??= {};
    for (const key of ["startTime", "startRound", "startTurn", "combat"]) delete data.duration[key];
    if (data.duration.seconds != null) data.duration.startTime = context.worldTime ?? 0;
    if (data.duration.rounds != null || data.duration.turns != null) {
        data.duration.startTime = context.worldTime ?? 0;
        if (context.combat) {
            data.duration.combat = context.combat.id;
            data.duration.startRound = context.combat.round ?? 0;
            data.duration.startTurn = context.combat.turn ?? 0;
        }
    }
    data.flags ??= {};
    // These are separate companions to the meal. Do not let a delayed native
    // GM relay clear a newly applied custom effect as part of its slot swap.
    if (data.flags[FEAST_ID]) delete data.flags[FEAST_ID].mealEffect;
    if (data.flags["ionrift-library"]) {
        delete data.flags["ionrift-library"].cookingBuff;
        delete data.flags["ionrift-library"].cookingBuffEffect;
    }
    if (data.flags.dae && Object.hasOwn(data.flags.dae, "transfer")) data.flags.dae.transfer = false;
    data.flags[MODULE_ID] = {
        ...(data.flags[MODULE_ID] ?? {}),
        recipeEffect: true,
        recipeId: recipe.id,
        tier: exceptional === true ? "exceptional" : "standard",
        sourceUuid: snapshot.uuid,
        clearOnLongRest: recipe.mffEffects?.clearOnLongRest !== false
    };
    return data;
}

export function linkedEffectsOn(actor) {
    return actor?.effects?.filter(effect => effect.flags?.[MODULE_ID]?.recipeEffect === true) ?? [];
}

export async function replaceLinkedEffects(actor, recipe, exceptional) {
    if (!actor?.isOwner) throw Error("The applying user cannot edit " + (actor?.name ?? "this actor") + ".");
    const errors = validateLinkedEffects(recipe);
    if (errors.length) throw Error(errors.join(" "));
    const selected = selectedLinkedEffects(recipe, exceptional);
    const key = actor.uuid;
    const previous = queues.get(key) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(async () => {
        const payloads = selected.map(snapshot => buildLinkedEffect(snapshot, recipe, exceptional, actor, {
            worldTime: game.time?.worldTime,
            combat: game.combat
        }));
        // Validate each document before deleting the previous recipe's effects.
        const EffectClass = globalThis.CONFIG?.ActiveEffect?.documentClass;
        if (EffectClass) for (const payload of payloads) new EffectClass(payload, { parent: actor }).validate({ strict: true });
        const old = linkedEffectsOn(actor);
        if (old.length) await actor.deleteEmbeddedDocuments("ActiveEffect", old.map(effect => effect.id));
        if (payloads.length) await actor.createEmbeddedDocuments("ActiveEffect", payloads);
        return payloads.length;
    });
    queues.set(key, work);
    try { return await work; }
    finally { if (queues.get(key) === work) queues.delete(key); }
}

export function installRecipeEffects({ api, MealService, MealEffects, DiscoveryService, GMRelay }) {
    // Keep the GM-only cookbook test setup consistent with the butcher party.
    const originalMembers = MealEffects.getPartyMembers.bind(MealEffects);
    MealEffects.getPartyMembers = () => {
        const members = originalMembers();
        return members.length ? members : DiscoveryService.partyActors().filter(actor => !api.system.isDead(actor));
    };

    async function applyForParty(recipeId, exceptional, actorUuids = null) {
        const recipe = api.recipes.get(recipeId);
        if (!recipe) throw Error("The served recipe no longer exists.");
        const errors = validateLinkedEffects(recipe);
        if (errors.length) throw Error(errors.join(" "));
        if (game.system.id !== "dnd5e" && selectedLinkedEffects(recipe, exceptional).length) throw Error("Linked Active Effects currently require D&D 5e.");
        const members = MealEffects.getPartyMembers().filter(actor => !actorUuids || actorUuids.includes(actor.uuid));
        const results = await Promise.allSettled(members.map(actor => replaceLinkedEffects(actor, recipe, exceptional)));
        const failed = results.flatMap((r, i) => r.status === "rejected" ? [members[i].name + ": " + r.reason.message] : []);
        if (failed.length) throw Error("Linked meal effects failed for " + failed.join("; "));
        return members;
    }

    GMRelay.registerHandler(LINKED_EFFECT_ACTION, async data => {
        if (!game.user.isGM) return;
        // Resolve everything from the GM's saved registry/party. Never accept
        // client-supplied effect documents or arbitrary recipient lists.
        if (typeof data.recipeId !== "string" || typeof data.exceptional !== "boolean") return;
        const requester = game.users.get?.(data.requesterId);
        const cook = typeof data.cookUuid === "string" ? await fromUuid(data.cookUuid) : null;
        if (!requester?.active || !cook ||
            (!requester.isGM && !cook.testUserPermission?.(requester, "OWNER"))) return;
        if (!DiscoveryService.partyActors().some(member => member.uuid === cook.uuid)) return;
        try { await applyForParty(data.recipeId, data.exceptional); }
        catch (error) { console.error(MODULE_ID, error); ui.notifications.error(error.message); }
    });

    const originalServe = MealService.serveParty;
    MealService.serveParty = async function(cook, recipe, exceptional) {
        const absentGM = MealEffects.serveNeedsAbsentGM();
        const result = await originalServe.call(this, cook, recipe, exceptional);
        if (absentGM) return result;
        const saved = api.recipes.get(recipe.id);
        if (!saved) return result;
        const members = MealEffects.getPartyMembers();
        if (!selectedLinkedEffects(saved, exceptional).length && !members.some(actor => linkedEffectsOn(actor).length)) return result;
        try {
            if (game.user.isGM) {
                await applyForParty(saved.id, exceptional === true);
            } else if (GMRelay.hasActiveGM()) {
                GMRelay._emit(LINKED_EFFECT_ACTION, {
                    recipeId: saved.id, exceptional: exceptional === true,
                    cookUuid: cook?.uuid, requesterId: game.user.id
                });
                ui.notifications.info("Linked recipe effects requested from the GM.");
            } else {
                await applyForParty(saved.id, exceptional === true, members.filter(actor => actor.isOwner).map(actor => actor.uuid));
            }
        } catch (error) {
            console.error(MODULE_ID, error);
            // Serving already succeeded: do not encourage another serve/roll.
            ui.notifications.error("The meal was served, but " + error.message);
        }
        return result;
    };

    Hooks.on("dnd5e.restCompleted", async (actor, result) => {
        if (!(result?.longRest === true || result?.type === "long")) return;
        const activeGM = game.users.activeGM;
        if (activeGM ? activeGM.id !== game.user.id : !actor.isOwner) return;
        const effects = linkedEffectsOn(actor).filter(effect => effect.flags[MODULE_ID].clearOnLongRest !== false);
        if (effects.length) {
            try { await actor.deleteEmbeddedDocuments("ActiveEffect", effects.map(effect => effect.id)); }
            catch (error) { console.error(MODULE_ID, error); ui.notifications.error("Could not clear linked meal effects after the long rest."); }
        }
    });
}

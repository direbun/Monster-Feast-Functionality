export const MODULE_ID = "monsters-feast-functionality";
export const FEAST_ID = "ionrift-monstrous-feast";
export const clone = value => structuredClone(value);
export const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[ch]));

export const EFFECTS = [
    ["tempHP", "Temporary HP (formula)", "formula"],
    ["ambitiousTempHP", "Exceptional temporary HP (formula)", "formula"],
    ["strengthAdvantage", "Strength advantage: number of uses (formula)", "formula"],
    ["darkvisionFeet", "Darkvision distance (feet)", "number"],
    ["poisonResistance", "Poison resistance: number of hits (formula)", "formula"],
    ["passivePerceptionBonus", "Exceptional meal: passive Perception bonus", "number"],
    ["wisdomBonus", "Wisdom check bonus", "number"],
    ["conSaveAdvantage", "Standard meal: next Constitution save advantage", "boolean"],
    ["wisSaveAdvantage", "Exceptional meal: next Wisdom save advantage", "boolean"],
    ["conSaveBonus", "Exceptional meal: uses of +1 Constitution save (formula)", "formula"]
];

// Follow the token's base actor and known provenance; never match by name.
export function canonicalActorUuid(uuid) {
    return typeof uuid === "string"
        ? uuid.replace(/^Compendium\.([^.]+)\.([^.]+)\.([^.]+)$/, "Compendium.$1.$2.Actor.$3")
        : null;
}
export function actorKeys(actor) {
    const keys = new Set();
    const seen = new Set();
    const queue = [actor];
    while (queue.length && seen.size < 16) {
        const current = queue.shift();
        if (!current || seen.has(current)) continue;
        seen.add(current);
        const token = current.token ?? (current.isToken ? current.parent : null);
        const base = token?.baseActor ?? globalThis.game?.actors?.get?.(token?.actorId);
        for (const raw of [current.uuid, base?.uuid, token?.actorId ? "Actor." + token.actorId : null,
            current._stats?.compendiumSource, current._source?._stats?.compendiumSource,
            current.flags?.core?.sourceId, current._stats?.duplicateSource]) {
            const uuid = canonicalActorUuid(raw);
            if (uuid) keys.add(uuid);
            if (uuid?.startsWith("Actor.") && uuid.split(".").length === 2) {
                const source = globalThis.game?.actors?.get?.(uuid.slice(6));
                if (source && !seen.has(source)) queue.push(source);
            }
        }
        if (base && base !== current) queue.push(base);
    }
    return [...keys];
}
export function findActorEntry(actor, creatures) {
    const keys = actorKeys(actor);
    // Prefer the specific world/token actor over its compendium ancestry.
    for (const key of keys) {
        for (const [id, entry] of Object.entries(creatures ?? {})) {
            if (Array.isArray(entry?.mffSources) && entry.mffSources.some(source => canonicalActorUuid(source?.uuid) === key)) return { ...entry, id };
        }
    }
    return null;
}

export function newCreature(id) {
    return { id, label: "New creature", tier: "common", minCR: 0, flavour: "",
        basic: [], standard: [], exceptional: [], mffSources: [] };
}
export function newRecipe(id) {
    return { id, name: "New recipe", description: "", skill: "sur", dc: 12,
        ingredients: [], linkedCreatures: [], output: {
            name: "New meal", img: "icons/consumables/food/stew-bowl-potato-red.webp",
            description: "", rarity: "common"
        }, partyEffect: {} };
}

export function setPath(object, path, value) {
    const parts = path.split(".");
    if (parts.some(key => ["__proto__", "prototype", "constructor"].includes(key))) throw Error("Invalid field.");
    let target = object;
    for (const key of parts.slice(0, -1)) target = target[key] ??= {};
    const key = parts.at(-1);
    if (value === undefined) delete target[key];
    else target[key] = value;
}

export function validateDraft(kind, draft, formulaValid = () => true) {
    const errors = [];
    if (!/^[a-zA-Z0-9_-]+$/.test(draft.id) || ["__proto__", "constructor", "prototype"].includes(draft.id)) errors.push("Invalid entry ID.");
    if (!(kind === "creatures" ? draft.label : draft.name)?.trim()) errors.push("A name is required.");
    const number = (value, label, min = 0, integer = false) => {
        if (!Number.isFinite(Number(value)) || Number(value) < min || (integer && !Number.isInteger(Number(value)))) errors.push(label + " must be " + (integer ? "a whole number" : "a number") + " of at least " + min + ".");
    };
    const formula = (value, label) => {
        if (value !== undefined && value !== "" && value !== true && !formulaValid(String(value))) errors.push(label + " has an invalid roll formula.");
    };
    if (kind === "creatures") {
        number(draft.minCR, "Minimum CR / level", -1);
        for (const tier of ["basic", "standard", "exceptional"]) {
            for (const row of draft[tier] ?? []) {
                if (!row.name?.trim()) errors.push(tier + ": each yield needs a name.");
                number(row.qty, tier + " quantity", 1, true);
                if (row.type === "loot" && row.mffValueGP !== undefined) number(row.mffValueGP, "Trophy GP value", 0);
                if (row.spoilsAfter !== undefined) number(row.spoilsAfter, "Spoilage rests", 0, true);
            }
        }
        if (draft.mishap?.damage) formula(draft.mishap.damage, "Mishap damage");
    } else {
        number(draft.dc, "Cooking DC", 0, true);
        if (!draft.output?.name?.trim()) errors.push("A meal name is required.");
        for (const row of draft.ingredients ?? []) {
            if (!row.name?.trim()) errors.push("Each ingredient needs a name.");
            number(row.quantity, "Ingredient quantity", 1, true);
        }
        if (draft.ambitiousOutput && !draft.ambitiousOutput.name?.trim()) errors.push("The exceptional meal needs a name.");
        if (draft.seasoning) {
            if (!draft.seasoning.accepts?.length) errors.push("Enter at least one accepted seasoning.");
            number(draft.seasoning.quantity, "Seasoning quantity", 1, true);
        }
        for (const [key, label, type] of EFFECTS) {
            const value = draft.partyEffect?.[key];
            if (value === undefined) continue;
            if (type === "formula") formula(value, label);
            if (type === "number") number(value, label);
        }
        if (draft.partyEffect?.ambitiousTempHP && !draft.partyEffect?.tempHP) errors.push("Set standard temporary HP as well as exceptional temporary HP.");
    }
    return errors;
}

// Merge the latest store, retaining unrelated changes; reject stale edits.
export function mergeEntry(store, kind, draft, baseline, remove = false) {
    const result = clone(store);
    const existing = kind === "creatures" ? result.creatures[draft.id] : result.recipes.find(row => row.id === draft.id);
    if (JSON.stringify(existing ?? null) !== JSON.stringify(baseline ?? null)) throw Error("This entry changed in another window. Reopen it before saving.");
    if (kind === "creatures") {
        if (remove) delete result.creatures[draft.id];
        else {
            const entry = clone(draft);
            delete entry.id;
            result.creatures[draft.id] = entry;
        }
    } else {
        const index = result.recipes.findIndex(row => row.id === draft.id);
        if (index !== -1) result.recipes.splice(index, 1);
        if (!remove) result.recipes.push(clone(draft));
    }
    return result;
}



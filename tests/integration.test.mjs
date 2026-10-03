import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { actorKeys, findActorEntry, newCreature, newRecipe, mergeEntry, validateDraft, escapeHTML, setPath, EFFECTS } from "../scripts/model.js";

const hooks = new Map();
globalThis.Hooks = {
    once(name, callback) { hooks.set(name, [...(hooks.get(name) ?? []), callback]); },
    on(name, callback) { hooks.set(name, [...(hooks.get(name) ?? []), callback]); }
};
let confirmations = true;
class Application {
    element = { querySelector: () => null, classList: { add() {}, remove() {} } };
    rendered = false;
    async render() { this.rendered = true; return this; }
    async close() { this.rendered = false; return this; }
    _onRender() {}
}
globalThis.foundry = {
    applications: {
        api: { ApplicationV2: Application, HandlebarsApplicationMixin: Class => Class, DialogV2: { confirm: async () => confirmations } },
        instances: new Map()
    },
    utils: { deepClone: structuredClone, randomID: () => Math.random().toString(36).slice(2, 14) }
};
const notices = [];
globalThis.ui = { notifications: Object.fromEntries(["info", "warn", "error"].map(k => [k, m => notices.push([k, m])])) };
const settings = new Map();
const modules = new Map([["monsters-feast-functionality", {}]]);
globalThis.game = {
    user: { id: "gm", isGM: true },
    users: { activeGM: { id: "gm" } },
    modules,
    system: { id: "dnd5e" },
    settings: {
        settings: new Map(),
        register(module, key, options) { settings.set(module + "." + key, structuredClone(options.default)); },
        registerMenu() {},
        get(module, key) { return settings.get(module + "." + key); },
        async set(module, key, value) { settings.set(module + "." + key, structuredClone(value)); return value; }
    },
    ionrift: { library: { classifyCreature: () => ({ id: "beast_wolf", tags: new Set(["beast"]), confidence: 1 }) } }
};
globalThis.Roll = { validate: value => !value.includes("INVALID") };
const documents = new Map();
globalThis.fromUuid = async uuid => documents.get(uuid);
const pages = [];
globalThis.Item = { create: async data => { pages.push(data); return data; } };

const upstream = new URL("../../ionrift-monstrous-feast/scripts/", import.meta.url);
const { CreatureRegistry } = await import(new URL("data/catalogs/CreatureRegistry.js", upstream));
const { RecipeRegistry } = await import(new URL("data/catalogs/RecipeRegistry.js", upstream));
const { HomebrewStore } = await import(new URL("services/content/HomebrewStore.js", upstream));
const { ButcherEngine } = await import(new URL("engine/ButcherEngine.js", upstream));
const { Library } = await import(new URL("compat/Library.js", upstream));
const { ButcherEligibility } = await import(new URL("engine/butcher/ButcherEligibility.js", upstream));
HomebrewStore.registerSetting();
let reloads = 0;
const api = game.ionrift.monstrousFeast = {
    registry: CreatureRegistry, recipes: RecipeRegistry, homebrew: HomebrewStore,
    engine: ButcherEngine,
    scanButcherCorpses: options => ButcherEngine.scanSceneCorpses(options),
    inspectButcher: token => ButcherEngine.inspectButcherEligibility(token),
    system: { isPlayerCharacter: actor => actor.type === "character", isDead: actor => Number(actor.system?.attributes?.hp?.value ?? 0) <= 0 },
    async reloadRegistries() {
        reloads++;
        CreatureRegistry._entries.clear();
        CreatureRegistry._sources.clear();
        RecipeRegistry._recipes.clear();
        RecipeRegistry._sources.clear();
        HomebrewStore.applyToRegistries();
    },
    refreshButcherMarkers() {},
    registerConsolePanel() {}
};

// Resolve browser-root module paths to the installed upstream files for Node.
// Production files are executed unchanged apart from import URL resolution.
const runtimeUrl = new URL("../scripts/module.js", import.meta.url);
let source = await readFile(runtimeUrl, "utf8");
source = source.replaceAll('"./model.js"', JSON.stringify(new URL("../scripts/model.js", import.meta.url).href))
    .replaceAll('"./editor.js"', JSON.stringify(new URL("../scripts/editor.js", import.meta.url).href))
    .replaceAll('"/modules/ionrift-monstrous-feast/scripts/compat/Library.js"', JSON.stringify(new URL("compat/Library.js", upstream).href))
    .replaceAll('"/modules/ionrift-monstrous-feast/scripts/services/cookbook/RecipePageService.js"', JSON.stringify(new URL("services/cookbook/RecipePageService.js", upstream).href));
source = source.replaceAll('"./recipe-effects.js"', JSON.stringify(new URL("../scripts/recipe-effects.js", import.meta.url).href));
source = source.replaceAll('"./gameplay.js"', JSON.stringify(new URL("../scripts/gameplay.js", import.meta.url).href));
source = source.replace(/"\/modules\/ionrift-monstrous-feast\/scripts\/([^"]+)"/g, (_, path) => JSON.stringify(new URL(path, upstream).href));
const runtime = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
for (const callback of hooks.get("init") ?? []) await callback();
for (const callback of hooks.get("ready") ?? []) await callback();
const { RegistryEditor } = await import("../scripts/editor.js");

test("actor identity matches tokens and imported compendium sources without name matching", () => {
    const creatures = {
        beast_pack: { label: "Pack", mffSources: [{ uuid: "Compendium.test.actors.Actor.wolf" }] },
        beast_local: { label: "Local", mffSources: [{ uuid: "Actor.local" }] }
    };
    assert.equal(findActorEntry({ uuid: "Scene.s.Token.t.Actor.local", isToken: true, parent: { actorId: "local" }, _stats: { compendiumSource: "Compendium.test.actors.Actor.wolf" } }, creatures).id, "beast_local");
    assert.equal(findActorEntry({ uuid: "Actor.imported", _stats: { compendiumSource: "Compendium.test.actors.Actor.wolf" } }, creatures).id, "beast_pack");
    assert.equal(findActorEntry({ uuid: "Actor.other", name: "Local" }, creatures), null);
    assert.deepEqual(actorKeys(null), []);
});

test("merge preserves unrelated homebrew, rejects stale edits, and deletes only selected entry", () => {
    const a = { label: "A", basic: [] };
    const store = { creatures: { beast_a: a, beast_b: { label: "B" } }, recipes: [newRecipe("cook_other")] };
    const merged = mergeEntry(store, "creatures", { ...a, id: "beast_a", label: "Changed" }, a);
    assert.equal(merged.creatures.beast_b.label, "B");
    assert.equal(merged.recipes.length, 1);
    assert.equal(store.creatures.beast_a.label, "A");
    assert.throws(() => mergeEntry(merged, "creatures", { ...a, id: "beast_a" }, a), /another window/);
    const deleted = mergeEntry(store, "creatures", { id: "beast_a" }, a, true);
    assert.equal(deleted.creatures.beast_a, undefined);
    assert.ok(deleted.creatures.beast_b);
});

test("validation rejects bad quantities, formula and incomplete output", () => {
    const c = newCreature("beast_test");
    c.basic.push({ name: "Meat", qty: -2 });
    assert.match(validateDraft("creatures", c).join(" "), /quantity/);
    const r = newRecipe("cook_test");
    r.output.name = "";
    r.partyEffect.tempHP = "INVALID";
    r.ingredients.push({ name: "Meat", quantity: 0.5 });
    const errors = validateDraft("recipes", r, Roll.validate).join(" ");
    assert.match(errors, /meal name/);
    assert.match(errors, /whole number/);
    assert.match(errors, /invalid roll/);
    assert.equal(validateDraft("recipes", newRecipe("cook_good")).length, 0);
});

test("editor HTML escapes document names and rejects prototype paths", () => {
    assert.equal(escapeHTML('<img onerror="bad">'), "&lt;img onerror=&quot;bad&quot;&gt;");
    assert.throws(() => setPath({}, "__proto__.polluted", true), /Invalid field/);
    const editor = new RegistryEditor();
    editor.draft = newCreature("beast_test");
    editor.draft.label = "<script>bad</script>";
    assert.ok(editor.editorHTML().includes("&lt;script&gt;"));
    assert.ok(!editor.editorHTML().includes("<script>"));
});

test("end-to-end actor drop, rewards, persistence and upstream butcher target", async () => {
    const actor = { documentName: "Actor", uuid: "Actor.wolf", id: "wolf", name: "Winter Wolf", type: "npc", system: { details: { cr: 3 } } };
    documents.set(actor.uuid, actor);
    const item = { documentName: "Item", uuid: "Item.meat", name: "Winter Wolf Meat", type: "consumable" };
    documents.set(item.uuid, item);
    const editor = new RegistryEditor();
    await editor.drop(JSON.stringify({ type: "Actor", uuid: actor.uuid }), "actor");
    await editor.drop(JSON.stringify({ type: "Item", uuid: item.uuid }), "standard");
    editor.draft.basic = [{ name: item.name, qty: 1, foodTag: "meat" }];
    editor.draft.exceptional = [{ name: item.name, qty: 3, foodTag: "meat" }];
    await editor.save();
    assert.equal(HomebrewStore.get().creatures[editor.draft.id].standard[0].qty, 1);
    assert.equal(Library.classify(actor).id, editor.draft.id);
    assert.equal(game.ionrift.library.classifyCreature(actor).id, "beast_wolf", "Other Ionrift modules keep the original classification");
    assert.equal(Library.classify({ uuid: "Actor.unrelated", name: actor.name }).id, "beast_wolf");
    const target = ButcherEligibility.buildTargetFromActor(actor, null);
    assert.equal(target.registryEntry.standard[0].name, item.name);
    assert.equal(target.classifierResult.id, editor.draft.id);
    editor.draft.minCR = 5;
    await editor.save();
    assert.equal(ButcherEligibility.buildTargetFromActor(actor, null), null, "CR restrictions are retained");
    editor.draft.minCR = 0;
    await editor.save();
});

test("recipe effects pass upstream validator and Get Page creates native inscription flags", async () => {
    const editor = new RegistryEditor();
    editor.kind = "recipes";
    editor.draft = newRecipe("cook_wolf");
    editor.draft.name = "Winter Stew";
    editor.draft.output.name = "Winter Stew";
    editor.draft.ingredients = [{ name: "Winter Wolf Meat", quantity: 1 }];
    for (const [key, , type] of EFFECTS) editor.draft.partyEffect[key] = type === "boolean" ? true : type === "number" ? 10 : "1d4";
    await editor.action("page", {});
    assert.equal(RecipeRegistry.get("cook_wolf").partyEffect.tempHP, "1d4");
    assert.equal(pages.at(-1).flags["ionrift-monstrous-feast"].isRecipePage, true);
    assert.equal(pages.at(-1).flags["ionrift-monstrous-feast"].recipeId, "cook_wolf");
    assert.equal(pages.at(-1).type, "loot");
    game.system.id = "pf2e";
    await editor.action("page", {});
    assert.equal(pages.at(-1).type, "equipment");
    game.system.id = "dnd5e";
});

test("recipe page inscription uses upstream discovery and consumes the page", async () => {
    const { configureRecipePageService, inscribeRecipePage } = await import(new URL("services/cookbook/RecipePageService.js", upstream));
    const { DiscoveryService } = await import(new URL("services/cookbook/DiscoveryService.js", upstream));
    const { GMRelay, GM_RELAY_ACTIONS } = await import(new URL("services/GMRelay.js", upstream));
    const flags = {};
    const book = { isOwner: true, name: "Cookbook", getFlag: (scope, key) => flags[key], setFlag: async (scope, key, value) => { flags[key] = value; } };
    const original = DiscoveryService.findPartyCookbook;
    DiscoveryService.findPartyCookbook = () => book;
    GMRelay.registerHandler(GM_RELAY_ACTIONS.inscribe, data => DiscoveryService.applyRelayedInscribe(data));
    configureRecipePageService({ playCeremony: async () => true });
    let consumed = false;
    const page = { parent: { id: "hero" }, getFlag: () => "cook_wolf", delete: async () => { consumed = true; } };
    try {
        assert.equal(await inscribeRecipePage(page), true);
        assert.deepEqual(flags.inscribedRecipes, ["cook_wolf"]);
        assert.equal(consumed, true);
    } finally { DiscoveryService.findPartyCookbook = original; }
});

test("save blocks unsupported effects and over-limit stores without dropping existing data", async () => {
    const before = structuredClone(HomebrewStore.get());
    const invalid = structuredClone(before);
    invalid.recipes[0].partyEffect.healing = "1d8";
    await assert.rejects(runtime.saveStore(invalid), /unknown buff key/);
    const overLimit = { creatures: {}, recipes: Array.from({ length: 51 }, (_, i) => newRecipe("cook_" + i)) };
    await assert.rejects(runtime.saveStore(overLimit), /limit 50/);
    assert.deepEqual(HomebrewStore.get(), before);
});

test("unsaved navigation can be cancelled and players cannot write", async () => {
    const editor = new RegistryEditor();
    editor.draft = newCreature("beast_unsaved");
    editor.dirty = true;
    confirmations = false;
    await editor.action("tab", { kind: "recipes" });
    assert.equal(editor.kind, "creatures");
    confirmations = true;
    game.user.isGM = false;
    await assert.rejects(runtime.saveStore(HomebrewStore.get()), /Only a GM/);
    await assert.rejects(editor.save(), /Only a GM/);
    game.user.isGM = true;
});

test("duplicate clears links and deletion removes custom matching", async () => {
    const editor = new RegistryEditor();
    const entry = CreatureRegistry.all()[0];
    editor.load(entry);
    await editor.action("duplicate", {});
    assert.deepEqual(editor.draft.mffSources, []);
    editor.load(entry);
    await editor.action("delete", {});
    assert.equal(Library.classify({ uuid: "Actor.wolf" }).id, "beast_wolf");
    assert.equal(HomebrewStore.get().recipes.length, 1);
    assert.ok(reloads > 0);
});



const { trophyPriceGP, trophyPriceUpdates, partyWithCookbookFallback, describeCorpse } = await import("../scripts/gameplay.js");

test("token matching follows base actor provenance and legacy compendium UUIDs", () => {
    const base = { uuid: "Actor.apeBase", _stats: { compendiumSource: "Compendium.dnd5e.monsters.Actor.ape" } };
    const tokenActor = { uuid: "Scene.s.Token.ape.Actor.apeBase", isToken: true,
        parent: { actorId: "apeBase", baseActor: base }, _stats: {} };
    const match = findActorEntry(tokenActor, {
        beast_ape: { mffSources: [{ uuid: "Compendium.dnd5e.monsters.ape" }] }
    });
    assert.equal(match.id, "beast_ape");
    assert.equal(findActorEntry({ uuid: "Actor.different", name: "Ape" }, {
        beast_ape: { label: "Ape", mffSources: [{ uuid: base.uuid }] }
    }), null);
});

test("GM-only fallback needs an actual cookbook and never replaces an existing party", () => {
    const book = { getFlag: (scope, key) => scope === "ionrift-monstrous-feast" && key === "isButcherCookbook" };
    const cook = { type: "character", items: [book] };
    const npc = { type: "npc", items: [book] };
    const noBook = { type: "character", items: [] };
    assert.deepEqual(partyWithCookbookFallback([], [cook, npc, noBook]), [cook]);
    assert.deepEqual(partyWithCookbookFallback([noBook], [cook]), [noBook]);
});

test("trophy values convert item currency, preserve zero, and target harvested loot only", () => {
    assert.equal(trophyPriceGP({ system: { price: { value: 15, denomination: "sp" } } }, "dnd5e"), 1.5);
    assert.equal(trophyPriceGP({ system: { price: { value: { gp: 2, sp: 3, cp: 4 } } } }, "pf2e"), 2.34);
    const actor = { items: [
        { id: "trophy", name: "Ape Skull", type: "loot", getFlag: () => true },
        { id: "ordinary", name: "Ape Skull", type: "loot", getFlag: () => false },
        { id: "food", name: "Ape Skull", type: "consumable", getFlag: () => true }
    ] };
    const rows = [{ name: "Ape Skull", type: "loot", qty: 3, mffValueGP: 12.5 }];
    const changes = trophyPriceUpdates(actor, rows, "dnd5e");
    assert.equal(changes.length, 1);
    assert.deepEqual(changes[0]["system.price"], { value: 12.5, denomination: "gp" });
    rows[0].mffValueGP = 0;
    assert.equal(trophyPriceUpdates(actor, rows, "dnd5e")[0]["system.price"].value, 0);
    rows[0].mffValueGP = -1;
    assert.deepEqual(trophyPriceUpdates(actor, rows, "dnd5e"), []);
    const draft = newCreature("beast_test");
    draft.basic = rows;
    assert.match(validateDraft("creatures", draft).join(" "), /Trophy GP value/);
});

test("changing a yield to trophy exposes GP field and dropping loot copies its value", async () => {
    const editor = new RegistryEditor();
    editor.draft = newCreature("beast_editor");
    documents.set("Item.skull", { documentName: "Item", uuid: "Item.skull", type: "loot", name: "Ape Skull",
        system: { price: { value: 250, denomination: "sp" } } });
    await editor.drop(JSON.stringify({ type: "Item", uuid: "Item.skull" }), "exceptional");
    assert.equal(editor.draft.exceptional[0].mffValueGP, 25);
    assert.match(editor.yieldHTML(editor.draft.exceptional[0], "exceptional", 0), /GP value per trophy/);
    assert.doesNotMatch(editor.yieldHTML({ name: "Meat", qty: 1 }, "basic", 0), /GP value per trophy/);
});

test("scene diagnostics distinguish combat timing, no butcher, CR and resolved corpses", () => {
    const info = { isDead: true, promptOnCombatEnd: true, registryEntry: { id: "beast_ape" },
        butchers: ["Cook"], combatStarted: true };
    assert.match(describeCorpse(info, {})[0], /chat is offered when combat ends/);
    assert.match(describeCorpse({ ...info, butchers: [] }, {}).join(" "), /No eligible butcher/);
    assert.match(describeCorpse({ ...info, registryEntry: null }, {}).join(" "), /minimum CR/);
    assert.match(describeCorpse({ ...info, butcherState: "harvested" }, {}).join(" "), /Already harvested/);
});

test("real engine recovers a dead compendium ape, shows combat marker, posts end-combat chat and prices the trophy", async () => {
    function flagged(data = {}) {
        const flags = {};
        return { ...data,
            getFlag: (scope, key) => flags[scope + "." + key],
            setFlag: async (scope, key, value) => { flags[scope + "." + key] = value; },
            unsetFlag: async (scope, key) => { delete flags[scope + "." + key]; }
        };
    }
    function merge(target, source) {
        const result = structuredClone(target);
        for (const [key, value] of Object.entries(source)) {
            result[key] = value && typeof value === "object" && !Array.isArray(value)
                ? merge(result[key] ?? {}, value) : value;
        }
        return result;
    }
    foundry.utils.mergeObject = merge;
    const book = flagged({ id: "cookbook", name: "Monster Cooking", isOwner: true });
    await book.setFlag("ionrift-monstrous-feast", "isButcherCookbook", true);
    const cook = flagged({ id: "gmCook", uuid: "Actor.gmCook", name: "GM Cook", type: "character", isOwner: true,
        hasPlayerOwner: false, items: [book], system: { attributes: { hp: { value: 10 } } } });
    cook.createEmbeddedDocuments = async (type, payloads) => {
        const items = payloads.map((p, i) => ({ ...p, id: "yield" + i,
            getFlag: (scope, key) => p.flags?.[scope]?.[key] }));
        cook.items.push(...items);
        return items;
    };
    cook.updateEmbeddedDocuments = async (type, updates) => {
        for (const change of updates) {
            const item = cook.items.find(i => i.id === change._id);
            if (change["system.price"]) item.system.price = change["system.price"];
            if (change["system.quantity"] !== undefined) item.system.quantity = change["system.quantity"];
        }
        return updates;
    };
    const base = { uuid: "Actor.apeBase", _stats: { compendiumSource: "Compendium.dnd5e.monsters.Actor.ape" } };
    const ape = flagged({ id: "apeBase", uuid: "Scene.test.Token.ape.Actor.apeBase", name: "Ape", type: "npc",
        isToken: true, parent: { actorId: "apeBase", baseActor: base },
        system: { details: { cr: 0.5 }, attributes: { hp: { value: 0, max: 19 } } } });
    const tokenDoc = flagged({ id: "apeToken", actorId: "apeBase" });
    const token = { id: "apeToken", actor: ape, document: tokenDoc };
    const actorList = [cook];
    game.actors = { contents: actorList, filter: fn => actorList.filter(fn), get: id => id === "apeBase" ? base : actorList.find(a => a.id === id) };
    globalThis.canvas = { ready: true, scene: flagged(), tokens: { placeables: [token], controlled: [] } };
    game.combat = { started: true };
    const messages = [];
    globalThis.ChatMessage = { getSpeaker: () => ({}), create: async data => { messages.push(data); return data; } };
    game.messages = [];
    let markers = [];
    ButcherEngine.configure({ markerService: { syncShow: rows => { markers = rows; }, count: () => markers.length, clear() {} } });
    await game.settings.set("ionrift-monstrous-feast", "promptOnCombatEnd", true);
    const creature = newCreature("beast_ape_test");
    creature.label = "Ape";
    creature.mffSources = [{ uuid: "Compendium.dnd5e.monsters.Actor.ape", name: "Ape" }];
    creature.standard = [{ name: "Ape Skull", type: "loot", qty: 2, mffValueGP: 25 }];
    const store = structuredClone(HomebrewStore.get());
    store.creatures[creature.id] = creature;
    await runtime.saveStore(store);
    assert.equal(markers.length, 1, "Already-dead token recovers when saved/rescanned");
    assert.equal(markers[0].actorName, "Ape");
    assert.equal(messages.length, 0, "No premature chat during active combat");
    assert.equal(ButcherEngine.findButcherActors()[0].id, cook.id);
    game.combat = null;
    await ButcherEngine.onCombatEnd({ combatants: { contents: [{ id: token.id, actor: ape }] } });
    assert.equal(messages.filter(m => m.flags["ionrift-monstrous-feast"].butcherPrompt).length, 1);
    const { SystemBridge } = await import(new URL("compat/SystemBridge.js", upstream));
    const { DiscoveryService } = await import(new URL("services/cookbook/DiscoveryService.js", upstream));
    const { GMRelay, GM_RELAY_ACTIONS } = await import(new URL("services/GMRelay.js", upstream));
    GMRelay.registerHandler(GM_RELAY_ACTIONS.discover, data => DiscoveryService.applyRelayedDiscovery(data));
    const previousRoll = SystemBridge.rollSurvival;
    SystemBridge.rollSurvival = async () => ({ total: 12, natural: 10 });
    try {
        const target = ButcherEngine.buildTargetFromActor(ape, token);
        await ButcherEngine.resolve(cook, target);
        const skull = cook.items.find(i => i.name === "Ape Skull");
        assert.equal(skull.system.quantity, 2);
        assert.deepEqual(skull.system.price, { value: 25, denomination: "gp" });
        assert.equal(tokenDoc.getFlag("ionrift-monstrous-feast", "butcherState"), "harvested");
        assert.deepEqual(book.getFlag("ionrift-monstrous-feast", "discoveredTypes"), ["beast_ape_test"]);
    } finally {
        SystemBridge.rollSurvival = previousRoll;
        globalThis.canvas = undefined;
        game.combat = null;
    }
});

test("GM relay applies trophy values after native item granting and stacking", async () => {
    const { GMRelay, GM_RELAY_ACTIONS } = await import(new URL("services/GMRelay.js", upstream));
    const cook = game.actors.contents[0];
    const before = cook.items.find(i => i.name === "Ape Skull").system.quantity;
    await GMRelay._dispatch(GM_RELAY_ACTIONS.grantYields, {
        actor: cook, creatureName: "Ape", tier: "common",
        yields: [{ name: "Ape Skull", type: "loot", qty: 1, mffValueGP: 30 }]
    });
    const skull = cook.items.find(i => i.name === "Ape Skull");
    assert.equal(skull.system.quantity, before + 1);
    assert.deepEqual(skull.system.price, { value: 30, denomination: "gp" });
});

test("flat HP hook processes death and healing once while leaving nested changes to Feast", async () => {
    const death = ButcherEngine.onCreatureDeath;
    const revoke = ButcherEngine.revokeButcherOffer;
    let deaths = 0;
    let revivals = 0;
    ButcherEngine.onCreatureDeath = async () => { deaths++; };
    ButcherEngine.revokeButcherOffer = async () => { revivals++; };
    try {
        const hook = hooks.get("updateActor")[0];
        await hook({}, { "system.attributes.hp.value": 0 });
        await hook({}, { "system.attributes.hp.value": 5 });
        await hook({}, { system: { attributes: { hp: { value: 0 } } } });
        assert.equal(deaths, 1);
        assert.equal(revivals, 1);
        game.users.activeGM = { id: "other" };
        await hook({}, { "system.attributes.hp.value": 0 });
        assert.equal(deaths, 1);
    } finally {
        ButcherEngine.onCreatureDeath = death;
        ButcherEngine.revokeButcherOffer = revoke;
        game.users.activeGM = { id: "gm" };
    }
});


const { snapshotEffect, buildLinkedEffect, selectedLinkedEffects, validateLinkedEffects, replaceLinkedEffects, LINKED_EFFECT_ACTION } = await import("../scripts/recipe-effects.js");

function effectSource(id, name, data = {}) {
    const payload = {
        _id: id, name, disabled: true, transfer: true,
        changes: [{ key: "system.attributes.ac.bonus", mode: 2, value: "1", priority: 20 }],
        duration: { seconds: 600, startTime: 20, startRound: 1, combat: "old" },
        statuses: ["invisible"],
        flags: { dae: { specialDuration: ["isAttacked"], transfer: true },
            "dfreds-convenient-effects": { isConvenient: true },
            ActiveAuras: { isAura: true, radius: "10", aura: "Allies" } },
        ...data
    };
    return { documentName: "ActiveEffect", uuid: "Compendium.test.effects.Item.meal.ActiveEffect." + id,
        name, parent: { uuid: "Compendium.test.effects.Item.meal" }, toObject: () => structuredClone(payload) };
}

test("effect snapshots retain automation flags and statuses but reset document identity and timing", () => {
    const source = effectSource("defense", "Meal Ward");
    const snapshot = snapshotEffect(source);
    const recipe = { id: "cook_fx", mffEffects: { standard: [snapshot] } };
    const payload = buildLinkedEffect(snapshot, recipe, false, { uuid: "Actor.cook" }, { worldTime: 900 });
    assert.equal(payload._id, undefined);
    assert.equal(payload.disabled, false);
    assert.equal(payload.transfer, false);
    assert.deepEqual(payload.changes, source.toObject().changes);
    assert.deepEqual(payload.statuses, ["invisible"]);
    assert.deepEqual(payload.flags.dae.specialDuration, ["isAttacked"]);
    assert.equal(payload.flags.dae.transfer, false);
    assert.equal(payload.flags["dfreds-convenient-effects"].isConvenient, true);
    assert.equal(payload.flags.ActiveAuras.radius, "10");
    assert.equal(payload.duration.startTime, 900);
    assert.equal(payload.duration.startRound, undefined);
    assert.equal(payload.duration.combat, undefined);
    assert.equal(source.toObject()._id, "defense");
    assert.equal(snapshot.data.duration.startTime, undefined);
});

test("standard and exceptional effects are independent, including a blank exceptional list", () => {
    const ward = snapshotEffect(effectSource("ward", "Ward"));
    const aura = snapshotEffect(effectSource("aura", "Aura", { changes: [] }));
    const recipe = { mffEffects: { standard: [ward], exceptional: [aura] } };
    assert.equal(selectedLinkedEffects(recipe, false)[0].name, "Ward");
    assert.equal(selectedLinkedEffects(recipe, true)[0].name, "Aura");
    recipe.mffEffects.exceptional = [];
    assert.deepEqual(selectedLinkedEffects(recipe, true), []);
    assert.deepEqual(validateLinkedEffects(recipe), []);
    recipe.mffEffects.standard[0].data.changes = "bad";
    assert.match(validateLinkedEffects(recipe).join(" "), /changes must be a list/);
});

test("editor accepts effect and item drops, deduplicates sources and preserves snapshots in homebrew export", async () => {
    const standard = effectSource("standard", "Meal Ward");
    const exceptional = effectSource("exceptional", "Meal Aura", { changes: [] });
    documents.set(standard.uuid, standard);
    documents.set("Item.effectTemplate", { documentName: "Item", effects: [exceptional] });
    const editor = new RegistryEditor();
    editor.kind = "recipes";
    editor.draft = newRecipe("cook_linked_fx");
    await editor.drop(JSON.stringify({ type: "ActiveEffect", uuid: standard.uuid }), "effect-standard");
    await editor.drop(JSON.stringify({ type: "ActiveEffect", uuid: standard.uuid }), "effect-standard");
    await editor.drop(JSON.stringify({ type: "Item", uuid: "Item.effectTemplate" }), "effect-exceptional");
    assert.equal(editor.draft.mffEffects.standard.length, 1);
    assert.equal(editor.draft.mffEffects.exceptional[0].name, "Meal Aura");
    await editor.save();
    const saved = HomebrewStore.exportPayload().recipes.find(r => r.id === editor.draft.id);
    assert.equal(saved.mffEffects.exceptional[0].data.flags.ActiveAuras.radius, "10");
    assert.match(editor.linkedEffectsHTML(saved), /Standard result/);
    assert.match(editor.linkedEffectsHTML(saved), /Exceptional result/);
    documents.delete(standard.uuid);
    await assert.rejects(editor.action("effect-refresh", { tier: "standard", index: "0" }), /saved copy still works/);
    assert.equal(editor.draft.mffEffects.standard[0].name, "Meal Ward");
    documents.set(standard.uuid, effectSource("standard", "Updated Ward"));
    await editor.action("effect-refresh", { tier: "standard", index: "0" });
    assert.equal(editor.draft.mffEffects.standard[0].name, "Updated Ward");
});

function effectActor(uuid, owned = true) {
    const actor = {
        uuid, id: uuid.split(".").at(-1), name: uuid, type: "character", hasPlayerOwner: true,
        isOwner: owned, system: { attributes: { hp: { value: 10 } } }, items: [],
        effects: [{ id: "unrelated", flags: { anotherModule: { keep: true } } }],
        testUserPermission: user => user.id === "player" || user.isGM,
        async createEmbeddedDocuments(type, payloads) {
            assert.equal(type, "ActiveEffect");
            const created = payloads.map((payload, i) => ({ ...structuredClone(payload), id: "effect" + i }));
            this.effects.push(...created);
            return created;
        },
        async deleteEmbeddedDocuments(type, ids) {
            assert.equal(type, "ActiveEffect");
            this.effects = this.effects.filter(e => !ids.includes(e.id));
        }
    };
    documents.set(uuid, actor);
    return actor;
}

test("real serving path applies only the cooked tier, replaces custom effects and preserves unrelated effects", async () => {
    const { MealService } = await import(new URL("services/meals/MealService.js", upstream));
    const cook = effectActor("Actor.effectsCook");
    const companion = effectActor("Actor.companion");
    const actors = [cook, companion];
    game.actors = { contents: actors, filter: fn => actors.filter(fn), get: id => actors.find(a => a.id === id) };
    game.time = { worldTime: 1200 };
    const recipe = RecipeRegistry.get("cook_linked_fx");
    await MealService.serveParty(cook, recipe, false);
    for (const actor of actors) {
        assert.equal(actor.effects.length, 2);
        assert.equal(actor.effects[1].name, "Meal Ward");
        assert.equal(actor.effects[1].duration.startTime, 1200);
    }
    await MealService.serveParty(cook, recipe, true);
    for (const actor of actors) {
        assert.equal(actor.effects.length, 2);
        assert.equal(actor.effects[1].name, "Meal Aura");
        assert.deepEqual(actor.effects[1].changes, [], "Flag-only aura effects must still be created");
    }
    RecipeRegistry.register(newRecipe("cook_plain"));
    await MealService.serveParty(cook, RecipeRegistry.get("cook_plain"), false);
    for (const actor of actors) assert.deepEqual(actor.effects.map(e => e.id), ["unrelated"]);
});

test("GM relay reads saved effects instead of client-supplied effect payloads", async () => {
    const { GMRelay } = await import(new URL("services/GMRelay.js", upstream));
    const actors = game.actors.contents;
    const cook = actors[0];
    const users = [{ id: "gm", active: true, isGM: true }, { id: "player", active: true, isGM: false }];
    game.users = { activeGM: users[0], get: id => users.find(u => u.id === id), filter: fn => users.filter(fn) };
    await GMRelay._dispatch(LINKED_EFFECT_ACTION, {
        recipeId: "cook_linked_fx", exceptional: true, cookUuid: cook.uuid, requesterId: "player",
        effectData: { name: "UNTRUSTED", changes: [{ key: "bad", value: "bad" }] },
        actorUuids: ["Actor.outsideParty"]
    });
    assert.equal(actors[1].effects.at(-1).name, "Meal Aura");
    await GMRelay._dispatch(LINKED_EFFECT_ACTION, {
        recipeId: "cook_linked_fx", exceptional: false, cookUuid: cook.uuid, requesterId: "unknown"
    });
    assert.equal(actors[1].effects.at(-1).name, "Meal Aura", "Unknown requester is ignored");
});

test("long rest removes only marked effects with cleanup enabled; source-only duration is retained", async () => {
    const actor = game.actors.contents[0];
    const recipe = structuredClone(RecipeRegistry.get("cook_linked_fx"));
    const hook = hooks.get("dnd5e.restCompleted").at(-1);
    await replaceLinkedEffects(actor, recipe, false);
    await hook(actor, { type: "short" });
    assert.equal(actor.effects.length, 2);
    await hook(actor, { type: "long" });
    assert.deepEqual(actor.effects.map(e => e.id), ["unrelated"]);
    recipe.mffEffects.clearOnLongRest = false;
    await replaceLinkedEffects(actor, recipe, true);
    await hook(actor, { longRest: true });
    assert.equal(actor.effects.length, 2);
    assert.equal(actor.effects[1].name, "Meal Aura");
});

test("effect writes reject nonowners and serialize repeat serving without stacking", async () => {
    const recipe = RecipeRegistry.get("cook_linked_fx");
    await assert.rejects(replaceLinkedEffects(effectActor("Actor.notOwned", false), recipe, false), /cannot edit/);
    const actor = effectActor("Actor.serial");
    await Promise.all([replaceLinkedEffects(actor, recipe, false), replaceLinkedEffects(actor, recipe, true)]);
    assert.equal(actor.effects.length, 2);
    assert.equal(actor.effects.at(-1).name, "Meal Aura");
});


test("player serving requests the GM and does not apply custom effects when no GM can serve nonowned members", async () => {
    const { MealService } = await import(new URL("services/meals/MealService.js", upstream));
    const { GMRelay } = await import(new URL("services/GMRelay.js", upstream));
    const [cook, companion] = game.actors.contents;
    const emit = GMRelay._emit;
    const filter = game.users.filter;
    const messages = [];
    GMRelay._emit = (action, payload) => messages.push({ action, payload });
    game.user = { id: "player", isGM: false };
    companion.isOwner = false;
    try {
        await MealService.serveParty(cook, RecipeRegistry.get("cook_linked_fx"), true);
        assert.equal(messages.length, 1);
        assert.equal(messages[0].action, LINKED_EFFECT_ACTION);
        assert.deepEqual(messages[0].payload, {
            recipeId: "cook_linked_fx", exceptional: true, cookUuid: cook.uuid, requesterId: "player"
        });
        game.users.filter = () => [];
        await MealService.serveParty(cook, RecipeRegistry.get("cook_linked_fx"), false);
        assert.equal(messages.length, 1, "Blocked serving must not request or apply linked effects");
    } finally {
        game.user = { id: "gm", isGM: true };
        game.users.filter = filter;
        companion.isOwner = true;
        GMRelay._emit = emit;
    }
});

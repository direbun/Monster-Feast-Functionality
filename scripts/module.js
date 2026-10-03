import { installRecipeEffects, validateLinkedEffects } from "./recipe-effects.js";
import { installGameplayFixes } from "./gameplay.js";
import { MODULE_ID, FEAST_ID, findActorEntry } from "./model.js";
import { RegistryEditor, configureEditor, openEditor } from "./editor.js";

let api;
let gameplay;
let reloadQueue = Promise.resolve();
function report(error) {
    console.error(MODULE_ID, error);
    ui.notifications.error("Monsters Feast - Functionality: " + error.message);
}
function refresh() {
    reloadQueue = reloadQueue.catch(() => {}).then(async () => {
        await api.reloadRegistries();
        for (const app of foundry.applications.instances.values()) {
            if (["CookbookApp", "LivingCookbookApp"].includes(app.constructor.name) && app.rendered) await app.render(false);
        }
        if (game.user.isGM) { await gameplay?.rescan(); await api.refreshButcherMarkers?.(); }
    });
    return reloadQueue;
}

export async function saveStore(store) {
    if (!game.user.isGM) throw Error("Only a GM can save registry content.");
    const effectErrors = (store.recipes ?? []).flatMap(validateLinkedEffects);
    if (effectErrors.length) throw Error(effectErrors.join("\n"));
    const check = api.homebrew.validateImport(store);
    if (!check.ok || check.errors?.length || check.dropped?.creatures || check.dropped?.recipes) {
        throw Error((check.errors ?? ["Content could not be validated."]).join("\n"));
    }
    const sources = new Map();
    for (const [id, creature] of Object.entries(store.creatures)) {
        for (const source of creature.mffSources ?? []) {
            if (sources.has(source.uuid) && sources.get(source.uuid) !== id) throw Error("An actor is linked to more than one creature entry. Remove the duplicate link before saving.");
            sources.set(source.uuid, id);
        }
    }
    await api.homebrew.set(store);
    try { await refresh(); }
    catch (error) { throw Error("Content was saved, but the registry refresh failed. Reload Foundry before continuing. " + error.message); }
}

function attachRegistry(app, element) {
    if (!game.user.isGM || app.constructor.name !== "CookbookApp") return;
    const root = element instanceof HTMLElement ? element : element?.[0] ?? app.element;
    const tab = root?.querySelector('[data-mf-tab="registry"]');
    if (!tab || tab.dataset.mffBound) return;
    tab.dataset.mffBound = "true";
    tab.title = "Open the creature and recipe editor";
    tab.addEventListener("click", event => {
        event.preventDefault();
        event.stopImmediatePropagation();
        openEditor();
    }, true);
    const toolbar = root.querySelector(".mf-gm-toolbar");
    if (toolbar && !toolbar.querySelector("[data-mff-launch]")) {
        const launch = document.createElement("button");
        launch.type = "button";
        launch.dataset.mffLaunch = "true";
        launch.title = "Edit creatures and recipes";
        launch.setAttribute("aria-label", launch.title);
        launch.innerHTML = '<i class="fas fa-pen-to-square"></i>';
        launch.addEventListener("click", () => openEditor());
        toolbar.append(launch);
    }
}

Hooks.once("init", () => {
    game.settings.registerMenu(MODULE_ID, "registryEditor", {
        name: "Creature and Recipe Registry",
        label: "Open Registry Editor",
        hint: "Create homebrew creatures, butcher rewards, recipes and recipe pages.",
        icon: "fas fa-utensils",
        type: RegistryEditor,
        restricted: true
    });
});

Hooks.once("ready", async () => {
    try {
        api = game.ionrift?.monstrousFeast;
        if (!api?.homebrew?.validateImport || !api?.registry || !api?.recipes || !api?.reloadRegistries) throw Error("Enable Monstrous Feast 1.1.0 or newer and its Ionrift Library dependency.");
        // This adapter is private to Feast: other Ionrift modules retain their
        // normal classifier. No actor or compendium documents are modified.
        const { Library } = await import("/modules/ionrift-monstrous-feast/scripts/compat/Library.js");
        const { buildRecipePageData } = await import("/modules/ionrift-monstrous-feast/scripts/services/cookbook/RecipePageService.js");
        const { DiscoveryService } = await import("/modules/ionrift-monstrous-feast/scripts/services/cookbook/DiscoveryService.js");
        const { GMRelay } = await import("/modules/ionrift-monstrous-feast/scripts/services/GMRelay.js");
        const { handleGrantYieldsRelay } = await import("/modules/ionrift-monstrous-feast/scripts/services/butcher/ItemFactory.js");
        const originalClassify = Library.classify.bind(Library);
        Library.classify = actor => {
            const original = originalClassify(actor);
            const entry = findActorEntry(actor, api.homebrew.get().creatures);
            return entry ? { ...(original ?? {}), id: entry.id, label: entry.label } : original;
        };
        gameplay = installGameplayFixes({ api, DiscoveryService, GMRelay, handleGrantYieldsRelay });
        const { MealService } = await import("/modules/ionrift-monstrous-feast/scripts/services/meals/MealService.js");
        const { MealEffects } = await import("/modules/ionrift-monstrous-feast/scripts/services/meals/MealEffects.js");
        installRecipeEffects({ api, MealService, MealEffects, DiscoveryService, GMRelay });
        configureEditor({
            api,
            classify: originalClassify,
            makeId: (prefix = "creature") => prefix.replace(/[^a-zA-Z0-9-]/g, "").toLowerCase() + "_mff_" + foundry.utils.randomID(12).toLowerCase(),
            saveStore,
            showSceneCheck: gameplay.showSceneCheck,
            createPage: async id => {
                if (!game.user.isGM) throw Error("Only a GM can create recipe pages.");
                const data = buildRecipePageData(id);
                if (!data) throw Error("Save the recipe before creating its page.");
                // The upstream helper returns a dnd5e loot payload. Preserve its
                // inscription flags while adapting physical fields for PF2e.
                if (game.system.id === "pf2e") {
                    data.type = "equipment";
                    data.system = {
                        description: data.system.description,
                        quantity: 1,
                        traits: { rarity: ["common", "uncommon", "rare", "unique"].includes(data.system.rarity) ? data.system.rarity : "rare" }
                    };
                }
                return Item.create(data);
            }
        });
        game.modules.get(MODULE_ID).api = { openRegistry: openEditor, checkScene: gameplay.showSceneCheck, rescan: gameplay.rescan };
        api.registerConsolePanel?.({
            id: "mff-editor",
            label: "Homebrew Editor",
            icon: "fas fa-pen-to-square",
            content: '<p>Create creatures, butcher rewards and recipes without editing JSON.</p><button type="button" data-mff-open>Open Registry Editor</button>',
            onRender: element => {
                if (!game.user.isGM) { element.replaceChildren(); return; }
                element.querySelector("[data-mff-open]")?.addEventListener("click", () => openEditor());
            }
        });
        Hooks.on("renderCookbookApp", attachRegistry);
        Hooks.on("renderApplicationV2", attachRegistry);
        Hooks.on("updateSetting", (setting, changes, options, userId) => {
            if (setting.key === FEAST_ID + "." + api.homebrew.SETTING_KEY && userId !== game.user.id) refresh().catch(report);
        });
        for (const app of foundry.applications.instances.values()) if (app.rendered) attachRegistry(app, app.element);
        console.info(MODULE_ID + " | Registry editor ready.");
    } catch (error) {
        report(error);
    }
});



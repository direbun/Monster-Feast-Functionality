import { snapshotEffect, validateLinkedEffects } from "./recipe-effects.js";
import { trophyPriceGP } from "./gameplay.js";
import { MODULE_ID, clone, escapeHTML as esc, EFFECTS, newCreature, newRecipe, setPath, validateDraft, mergeEntry, findActorEntry } from "./model.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
let services;
let instance;
export function configureEditor(value) { services = value; }
export function openEditor() {
    if (!game.user.isGM) return ui.notifications.warn("Only a GM can edit the feast registry.");
    if (!services) return ui.notifications.warn("The feast editor is not ready. Check that Monstrous Feast is enabled.");
    instance ??= new RegistryEditor();
    return instance.render(true);
}
const button = (label, action, attrs = "") => '<button type="button" data-mff-action="' + action + '" ' + attrs + '>' + esc(label) + '</button>';
function field(label, path, value, type = "text", attrs = "") {
    const control = type === "textarea"
        ? '<textarea data-field="' + path + '" ' + attrs + '>' + esc(value) + '</textarea>'
        : '<input type="' + type + '" data-field="' + path + '" value="' + esc(value) + '" ' + attrs + '>';
    return '<label class="mff-field"><span>' + esc(label) + '</span>' + control + '</label>';
}
function select(label, path, value, choices) {
    return '<label class="mff-field"><span>' + esc(label) + '</span><select data-field="' + path + '">' + choices.map(([key, text]) =>
        '<option value="' + esc(key) + '"' + (value === key ? ' selected' : '') + '>' + esc(text) + '</option>').join("") + '</select></label>';
}
const rarities = ["common", "uncommon", "rare", "veryRare", "legendary"].map(v => [v, v === "veryRare" ? "Very rare" : v]);
const tiers = rarities.filter(([v]) => v !== "veryRare");

export class RegistryEditor extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
        id: "monsters-feast-registry-editor",
        classes: ["mff-editor"],
        position: { width: 1040, height: 800 },
        window: { title: "Monsters Feast - Registry Editor", icon: "fas fa-utensils", resizable: true }
    };
    static PARTS = { body: { template: "modules/" + MODULE_ID + "/templates/editor.hbs" } };
    kind = "creatures";
    draft = null;
    baseline = null;
    dirty = false;
    busy = false;
    search = "";
    scrollTop = 0;

    async _prepareContext() {
        if (!game.user.isGM) return { content: "<p>Only a GM can edit this registry.</p>" };
        const api = services.api;
        const list = this.kind === "creatures" ? api.registry.all() : api.recipes.all();
        const store = api.homebrew.get();
        const rows = list.map(entry => {
            const own = this.kind === "creatures" ? Object.hasOwn(store.creatures, entry.id) : store.recipes.some(r => r.id === entry.id);
            return '<button type="button" class="mff-entry' + (this.draft?.id === entry.id ? " selected" : "") +
                '" data-mff-action="select" data-id="' + esc(entry.id) + '" data-search="' + esc((entry.label ?? entry.name).toLowerCase()) +
                '"><strong>' + esc(entry.label ?? entry.name) + '</strong><small>' + (own ? "World homebrew" : "Bundled / pack") + '</small></button>';
        }).join("");
        return { content:
            '<header class="mff-heading"><div><h2>Make the hunt your own</h2><p>Creatures, ingredients and recipes for your table.</p></div>' +
            button("Scene Check", "scene") + button("Export backup", "export") + '</header><div class="mff-layout"><aside class="mff-sidebar"><nav>' +
            button("Creatures", "tab", 'data-kind="creatures" aria-pressed="' + (this.kind === "creatures") + '"') +
            button("Recipes", "tab", 'data-kind="recipes" aria-pressed="' + (this.kind === "recipes") + '"') +
            '</nav><input type="search" class="mff-search" aria-label="Search registry" placeholder="Search registry..." value="' + esc(this.search) + '">' +
            button(this.kind === "creatures" ? "+ New creature" : "+ New recipe", "new") +
            '<div class="mff-entries">' + rows + '</div></aside><main class="mff-main">' +
            (this.draft ? this.editorHTML() : '<div class="mff-empty" data-drop="actor"><i class="fas fa-drumstick-bite"></i><h3>Your next feast starts here</h3><p>Select an entry, create a recipe, or drop a creature from Actors, a compendium, or the scene here.</p></div>') +
            '</main></div><footer class="mff-footer"><span class="mff-status">' + (this.dirty ? "Unsaved changes" : "World homebrew survives module updates") +
            '</span>' + (this.draft ? button("Duplicate", "duplicate") + button("Delete homebrew", "delete", !this.baseline ? "disabled" : "") +
            (this.kind === "recipes" ? button("Get Page", "page", 'title="Save and create a recipe page in the Items directory"') : "") +
            button("Save", "save", 'class="mff-primary"') : "") + '</footer>'
        };
    }

    editorHTML() {
        const d = this.draft;
        return '<div class="mff-title"><h3>' + esc(this.kind === "creatures" ? d.label : d.name) +
            '</h3><small>ID: ' + esc(d.id) + '</small></div>' +
            (!this.baseline && (this.kind === "creatures" ? services.api.registry.get(d.id) : services.api.recipes.get(d.id))
                ? '<p class="mff-note">Saving creates a world override of this entry. Delete the override to restore the original.</p>' : "") +
            (this.kind === "creatures" ? this.creatureHTML(d) : this.recipeHTML(d));
    }

    creatureHTML(d) {
        const sources = d.mffSources ?? [];
        let html = '<section class="mff-card" data-drop="actor"><h4>Creature actors</h4><p class="mff-note">Drop actors here. Matches these actors and their scene tokens; a compendium entry also matches actors imported from it.</p>' +
            sources.map((s, i) => '<div class="mff-source"><span>' + esc(s.name) + '<small>' + esc(s.uuid) + '</small></span>' +
                button("Remove", "remove", 'data-list="mffSources" data-index="' + i + '"') + '</div>').join("") +
            (!sources.length ? '<p class="mff-note">No actor linked. Existing category entries still use their original classifier; new entries need an actor.</p>' : "") + '</section>' +
            '<section class="mff-card mff-grid">' + field("Creature name", "label", d.label) +
            select("Rarity tier", "tier", d.tier, tiers) + field("Minimum CR / level", "minCR", d.minCR, "number", 'min="-1" step="any"') +
            field("Butchering flavour", "flavour", d.flavour, "textarea") + '</section>';
        for (const [tier, label] of [["basic", "Basic: below DC"], ["standard", "Standard: meets DC"], ["exceptional", "Exceptional: DC + 5 / natural 20"]]) {
            html += '<section class="mff-card" data-drop="' + tier + '"><h4>' + label + '</h4><p class="mff-note">Drop items here or add a named yield. Each tier is the complete reward for that result.</p>' +
                (d[tier] ?? []).map((row, i) => this.yieldHTML(row, tier, i)).join("") +
                button("+ Add yield", "add", 'data-list="' + tier + '"') + '</section>';
        }
        html += '<section class="mff-card"><h4>Natural 1 mishap</h4>' +
            (d.mishap ? '<div class="mff-grid">' + field("Damage formula", "mishap.damage", d.mishap.damage) +
                field("Damage type", "mishap.damageType", d.mishap.damageType) +
                field("Description", "mishap.desc", d.mishap.desc, "textarea") + '</div>' + button("Remove mishap", "optional", 'data-key="mishap"')
                : button("+ Add mishap", "optional", 'data-key="mishap"')) + '</section>';
        return html;
    }

    yieldHTML(row, tier, i) {
        const path = tier + "." + i + ".";
        return '<div class="mff-row">' + field("Item name", path + "name", row.name) +
            field("Quantity", path + "qty", row.qty, "number", 'min="1" step="1"') +
            select("Kind", path + "type", row.type === "loot" ? "loot" : "", [["", "Food"], ["loot", "Trophy / loot"]]) +
            (row.type === "loot" ? field("GP value per trophy", path + "mffValueGP", row.mffValueGP ?? "", "number", 'min="0" step="0.01" placeholder="Leave blank for default"') : "") +
            field("Food tag", path + "foodTag", row.foodTag ?? "", "text", 'placeholder="meat, plant, essence"') +
            field("Spoils after rests", path + "spoilsAfter", row.spoilsAfter ?? "", "number", 'min="0" step="1"') +
            button("Remove", "remove", 'data-list="' + tier + '" data-index="' + i + '"') + '</div>';
    }

    recipeHTML(d) {
        let html = '<section class="mff-card mff-grid">' + field("Recipe name", "name", d.name) +
            field("Cooking DC (Survival)", "dc", d.dc, "number", 'min="0" step="1"') +
            field("Recipe description", "description", d.description, "textarea") + '</section>';
        html += '<section class="mff-card" data-drop="linkedCreatures"><h4>Linked creatures</h4><p class="mff-note">Leave empty for a pantry recipe. Linked recipes require discovering a matching creature as well as inscription. Drop a registered actor here, or choose creatures below.</p>' +
            '<select multiple size="5" data-field="linkedCreatures" aria-label="Linked creatures">' +
            services.api.registry.all().map(c => '<option value="' + esc(c.id) + '"' + ((d.linkedCreatures ?? []).includes(c.id) ? " selected" : "") + '>' + esc(c.label) + '</option>').join("") +
            (d.linkedCreatures ?? []).filter(id => !services.api.registry.get(id)).map(id => '<option selected value="' + esc(id) + '">' + esc(id) + ' (unavailable)</option>').join("") +
            '</select><p class="mff-note">Ctrl-click to select or deselect multiple creatures.</p></section>';
        html += '<section class="mff-card" data-drop="ingredients"><h4>Ingredients</h4><p class="mff-note">Drop items here, choose a saved butcher yield, or type an ingredient name. Names must match inventory items exactly.</p>' +
            (d.ingredients ?? []).map((row, i) => '<div class="mff-row mff-ingredient">' +
                field("Item name", "ingredients." + i + ".name", row.name) +
                field("Quantity", "ingredients." + i + ".quantity", row.quantity, "number", 'min="1" step="1"') +
                button("Remove", "remove", 'data-list="ingredients" data-index="' + i + '"') + '</div>').join("") +
            '<div class="mff-inline">' + button("+ Add ingredient", "add", 'data-list="ingredients"') +
            '<select class="mff-yield-choice" aria-label="Choose saved butcher yield"><option value="">Choose a butcher yield...</option>' +
            [...new Set(services.api.registry.all().flatMap(c => ["basic", "standard", "exceptional"].flatMap(t => (c[t] ?? []).map(y => y.name))))].sort().map(name =>
                '<option value="' + esc(name) + '">' + esc(name) + '</option>').join("") + '</select>' + button("Add chosen yield", "ingredient") + '</div></section>';
        html += this.linkedEffectsHTML(d);
        html += this.outputHTML("output", "Standard meal", d.output);
        html += d.ambitiousOutput ? this.outputHTML("ambitiousOutput", "Exceptional meal", d.ambitiousOutput) + button("Remove exceptional meal", "optional", 'data-key="ambitiousOutput"')
            : button("+ Add exceptional meal", "optional", 'data-key="ambitiousOutput"');
        html += '<section class="mff-card"><h4>Seasoning</h4>' + (d.seasoning ?
            '<div class="mff-grid">' + field("Accepted seasonings (one per line)", "seasoning.accepts", d.seasoning.accepts.join("\n"), "textarea") +
            field("Quantity", "seasoning.quantity", d.seasoning.quantity, "number", 'min="1" step="1"') + '</div>' +
            button("Remove seasoning", "optional", 'data-key="seasoning"') : button("+ Add seasoning", "optional", 'data-key="seasoning"')) + '</section>';
        html += '<section class="mff-card"><h4>Meal effects</h4><p class="mff-note">Leave unused effects blank. Roll formulas can include dice and @prof. Duration and standard/exceptional behaviour follow Monstrous Feast. This version supports temporary HP, not direct healing.</p><div class="mff-grid">';
        for (const [key, label, type] of EFFECTS) {
            const value = d.partyEffect?.[key];
            html += type === "boolean" ? '<label class="mff-check"><input type="checkbox" data-field="partyEffect.' + key + '"' + (value ? " checked" : "") + '> ' + esc(label) + '</label>' :
                field(label, "partyEffect." + key, value === true ? "1d4" : value ?? "", type === "number" ? "number" : "text", type === "number" ? 'min="0" step="any"' : "");
        }
        return html + '</div></section><section class="mff-card mff-grid">' + field("Success narration", "successNarrative", d.successNarrative, "textarea") +
            field("Failure narration", "failNarrative", d.failNarrative, "textarea") + '</section>';
    }

    linkedEffectsHTML(recipe) {
        let html = '<section class="mff-card"><h4>Linked Active Effects</h4><p class="mff-note">Drop an Active Effect, or an item containing effects, into either result. These saved copies apply to the party when the meal is served. Exceptional uses only its own list. DAE, Convenient Effects and aura settings are preserved; their modules must be enabled for those features.</p>';
        for (const [tier, label] of [["standard", "Standard result"], ["exceptional", "Exceptional result"]]) {
            const effects = recipe.mffEffects?.[tier] ?? [];
            html += '<section class="mff-card" data-drop="effect-' + tier + '"><h4>' + label + '</h4>' +
                (effects.length ? effects.map((effect, index) => '<div class="mff-source"><span><strong>' + esc(effect.name) +
                    '</strong><small>' + esc(effect.uuid || "Saved copy") + '</small><small>' + esc((effect.data?.changes ?? []).length) +
                    ' change(s)</small></span><div>' + button("Open source", "effect-open", 'data-tier="' + tier + '" data-index="' + index + '"') +
                    button("Refresh copy", "effect-refresh", 'data-tier="' + tier + '" data-index="' + index + '"') +
                    button("Remove", "effect-remove", 'data-tier="' + tier + '" data-index="' + index + '"') + '</div></div>').join("") :
                    '<p class="mff-note">Drop effects here. No custom effects for this result yet.</p>') + '</section>';
        }
        html += button("Copy standard to exceptional", "effect-copy") +
            '<label class="mff-check"><input type="checkbox" data-field="mffEffects.clearOnLongRest"' +
            (recipe.mffEffects?.clearOnLongRest !== false ? " checked" : "") +
            '> Remove linked effects on a long rest</label><p class="mff-note">Their own durations start when served. A later served meal replaces these linked effects. Edit the source item, then Refresh copy to update a saved effect. Active Effect support currently targets D&amp;D 5e.</p></section>';
        return html;
    }
    outputHTML(path, title, output) {
        return '<section class="mff-card" data-drop="' + path + '"><h4>' + title + '</h4><p class="mff-note">Drop an item to copy its name, image and description.</p><div class="mff-grid">' +
            field("Meal name", path + ".name", output.name) + field("Image path", path + ".img", output.img) +
            select("Rarity", path + ".rarity", output.rarity ?? "common", rarities) +
            field("Meal description (HTML supported)", path + ".description", output.description, "textarea") + '</div></section>';
    }

    _onRender(context, options) {
        super._onRender(context, options);
        const root = this.element;
        const main = root.querySelector(".mff-main");
        if (main) main.scrollTop = this.scrollTop;
        root.querySelectorAll("[data-mff-action]").forEach(el => el.addEventListener("click", event => {
            event.preventDefault();
            this.run(() => this.action(el.dataset.mffAction, el.dataset));
        }));
        root.querySelectorAll("[data-field]").forEach(el => {
            el.addEventListener(el.tagName === "SELECT" || el.type === "checkbox" ? "change" : "input", () => {
                let value = el.type === "checkbox" ? (el.dataset.field === "mffEffects.clearOnLongRest" ? el.checked : (el.checked || undefined)) : el.value;
                if (el.multiple) value = [...el.selectedOptions].map(o => o.value);
                else if (el.dataset.field === "seasoning.accepts") value = el.value.split("\n").map(s => s.trim()).filter(Boolean);
                else if (el.type === "number") value = el.value === "" ? undefined : Number(el.value);
                else if (el.dataset.field.startsWith("partyEffect.") && value === "") value = undefined;
                setPath(this.draft, el.dataset.field, value);
                if (el.dataset.field.endsWith(".type")) { this.markDirty(); this.run(() => this.redraw()); }
                this.markDirty();
            });
        });
        const search = root.querySelector(".mff-search");
        const filter = () => {
            this.search = search.value;
            root.querySelectorAll("[data-search]").forEach(el => { el.hidden = !el.dataset.search.includes(this.search.toLowerCase()); });
        };
        search?.addEventListener("input", filter);
        if (search) filter();
        root.querySelectorAll("[data-drop]").forEach(zone => {
            zone.addEventListener("dragover", event => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; zone.classList.add("mff-dragover"); });
            zone.addEventListener("dragleave", () => zone.classList.remove("mff-dragover"));
            zone.addEventListener("drop", event => {
                event.preventDefault(); event.stopPropagation(); zone.classList.remove("mff-dragover");
                const raw = event.dataTransfer.getData("text/plain");
                this.run(() => this.drop(raw, zone.dataset.drop));
            });
        });
    }

    markDirty() {
        this.dirty = true;
        const status = this.element?.querySelector(".mff-status");
        if (status) status.textContent = "Unsaved changes";
    }
    async redraw(reset = false) {
        this.scrollTop = reset ? 0 : this.element?.querySelector(".mff-main")?.scrollTop ?? 0;
        await this.render(true);
    }
    async run(callback) {
        if (this.busy || !game.user.isGM) return;
        this.busy = true;
        this.element?.classList.add("mff-busy");
        try { await callback(); }
        catch (error) {
            console.error(MODULE_ID, error);
            ui.notifications.error(error.message ?? "The registry operation failed.");
        } finally { this.busy = false; this.element?.classList.remove("mff-busy"); }
    }
    async discard() {
        if (!this.dirty) return true;
        return foundry.applications.api.DialogV2.confirm({
            window: { title: "Unsaved registry changes" },
            content: "<p>Discard the unsaved changes to this entry?</p>",
            rejectClose: false, modal: true
        });
    }
    async close(options = {}) {
        if (this.busy || !(await this.discard())) return this;
        this.dirty = false;
        this.draft = null; this.baseline = null; return super.close(options);
    }
    load(entry) {
        this.draft = clone(entry);
        const store = services.api.homebrew.get();
        this.baseline = clone((this.kind === "creatures" ? store.creatures[entry.id] : store.recipes.find(r => r.id === entry.id)) ?? null);
        this.dirty = false;
    }

    async action(action, data) {
        if (action.startsWith("effect-")) {
            this.draft.mffEffects ??= { standard: [], exceptional: [], clearOnLongRest: true };
            const config = this.draft.mffEffects;
            if (action === "effect-copy") {
                config.exceptional = clone(config.standard ?? []);
            } else {
                const effect = config[data.tier]?.[Number(data.index)];
                if (!effect) throw Error("That linked effect no longer exists.");
                if (action === "effect-remove") config[data.tier].splice(Number(data.index), 1);
                else {
                    const source = effect.uuid ? await fromUuid(effect.uuid) : null;
                    if (!source) throw Error("The source effect is unavailable. The saved copy still works; drop a replacement to change it.");
                    if (action === "effect-open") return source.sheet?.render(true);
                    config[data.tier][Number(data.index)] = snapshotEffect(source);
                }
            }
            this.markDirty();
            return this.redraw();
        }
        if (action === "scene") return services.showSceneCheck();
        if (action === "export") return services.api.homebrew.exportJsonFile();
        if (["tab", "new", "select"].includes(action) && !(await this.discard())) return;
        if (action === "tab") { this.kind = data.kind; this.draft = null; this.dirty = false; this.search = ""; }
        if (action === "new") {
            this.draft = this.kind === "creatures" ? newCreature(services.makeId()) : newRecipe(services.makeId("cook"));
            this.baseline = null; this.dirty = true;
        }
        if (action === "select") {
            const entry = (this.kind === "creatures" ? services.api.registry : services.api.recipes).get(data.id);
            if (!entry) throw Error("That entry is no longer available.");
            this.load(entry);
        }
        if (action === "save" || action === "page") {
            await this.save();
            if (action === "page") {
                await services.createPage(this.draft.id);
                ui.notifications.info("Recipe page created in the Items directory.");
            }
            return this.redraw();
        }
        if (action === "duplicate") {
            this.draft.id = services.makeId(this.kind === "recipes" ? "cook" : this.draft.id.split("_")[0]);
            if (this.kind === "creatures") { this.draft.label += " (copy)"; this.draft.mffSources = []; }
            else this.draft.name += " (copy)";
            this.baseline = null; this.markDirty();
        }
        if (action === "delete") {
            if (!this.baseline) return;
            const linked = this.kind === "creatures" ? services.api.recipes.all().filter(r => r.linkedCreatures?.includes(this.draft.id)) : [];
            const confirmed = await foundry.applications.api.DialogV2.confirm({
                window: { title: "Delete homebrew entry" },
                content: "<p>Delete " + esc(this.draft.label ?? this.draft.name) + "? A bundled entry with the same ID will be restored if present.</p>" +
                    (linked.length ? "<p>Linked recipes: " + esc(linked.map(r => r.name).join(", ")) + ". Their links will be retained; update them if this creature has no bundled entry.</p>" : "") +
                    (this.kind === "recipes" ? "<p>Existing recipe pages and cookbook inscriptions keep this ID. They cannot resolve it unless a recipe with this ID exists.</p>" : ""),
                rejectClose: false, modal: true
            });
            if (!confirmed) return;
            const next = mergeEntry(services.api.homebrew.get(), this.kind, this.draft, this.baseline, true);
            await services.saveStore(next);
            this.draft = null; this.baseline = null; this.dirty = false;
        }
        if (action === "add") {
            (this.draft[data.list] ??= []).push(data.list === "ingredients" ? { name: "", quantity: 1 } : { name: "", qty: 1, foodTag: "meat", spoilsAfter: 1 });
            this.markDirty();
        }
        if (action === "remove") { this.draft[data.list].splice(Number(data.index), 1); this.markDirty(); }
        if (action === "ingredient") {
            const name = this.element.querySelector(".mff-yield-choice").value;
            if (!name) throw Error("Choose a butcher yield first.");
            this.draft.ingredients.push({ name, quantity: 1 }); this.markDirty();
        }
        if (action === "optional") {
            if (this.draft[data.key]) delete this.draft[data.key];
            else this.draft[data.key] = {
                mishap: { type: "damage", damage: "1d6", damageType: "slashing", desc: "" },
                seasoning: { accepts: [], quantity: 1 },
                ambitiousOutput: clone(this.draft.output ?? {})
            }[data.key];
            this.markDirty();
        }
        await this.redraw(["tab", "new", "select", "duplicate"].includes(action));
    }

    async save() {
        if (!game.user.isGM) throw Error("Only a GM can save.");
        const errors = validateDraft(this.kind, this.draft, formula => Roll.validate(formula));
        if (this.kind === "recipes") errors.push(...validateLinkedEffects(this.draft));
        if (this.kind === "creatures" && !this.baseline && !services.api.registry.get(this.draft.id) && !this.draft.mffSources?.length) errors.push("Drop a creature actor into this entry before saving.");
        if (errors.length) throw Error(errors.join("\n"));
        const next = mergeEntry(services.api.homebrew.get(), this.kind, this.draft, this.baseline);
        await services.saveStore(next);
        this.load(this.draft);
        ui.notifications.info("Registry entry saved.");
    }

    async drop(raw, target) {
        let data;
        try { data = JSON.parse(raw); } catch { throw Error("Drag an Actor, Token or Item from Foundry."); }
        if (!["Actor", "Token", "Item", "ActiveEffect"].includes(data.type) || typeof data.uuid !== "string") throw Error("This drop needs a Foundry Actor, Token or Item.");
        let doc = await fromUuid(data.uuid);
        if (doc?.documentName === "Token") doc = doc.actor;
        if (!doc) throw Error("Could not resolve the dropped document.");
        if (target.startsWith("effect-")) {
            if (game.system.id !== "dnd5e") throw Error("Linked Active Effects currently require D&D 5e.");
            const effects = doc.documentName === "ActiveEffect" ? [doc] :
                doc.documentName === "Item" ? [...(doc.effects ?? [])] : [];
            if (!effects.length) throw Error("Drop an Active Effect, or an item with at least one Active Effect.");
            this.draft.mffEffects ??= { standard: [], exceptional: [], clearOnLongRest: true };
            const tier = target.slice("effect-".length);
            const rows = this.draft.mffEffects[tier] ??= [];
            const copies = effects.map(snapshotEffect);
            for (const copy of copies) {
                const index = copy.uuid ? rows.findIndex(row => row.uuid === copy.uuid) : -1;
                if (index === -1) rows.push(copy); else rows[index] = copy;
            }
            this.markDirty();
            return this.redraw();
        }
        if (target === "actor" || target === "linkedCreatures") {
            if (doc.documentName !== "Actor") throw Error("Drop a creature actor here.");
            if (services.api.system.isPlayerCharacter?.(doc)) throw Error("Drop an NPC creature, not a player character.");
            const existing = findActorEntry(doc, services.api.homebrew.get().creatures);
            if (target === "linkedCreatures") {
                const id = existing?.id ?? services.classify(doc)?.id;
                if (!id || !services.api.registry.get(id)) throw Error("Save this creature in the Creatures tab first.");
                this.draft.linkedCreatures = [...new Set([...(this.draft.linkedCreatures ?? []), id])];
            } else {
                if (existing && this.draft?.id !== existing.id) {
                    if (!(await this.discard())) return;
                    this.kind = "creatures"; this.load(existing);
                    return this.redraw(true);
                }
                if (!this.draft || this.kind !== "creatures") {
                    if (!(await this.discard())) return;
                    this.kind = "creatures"; this.draft = newCreature(services.makeId()); this.baseline = null;
                }
                const classification = services.classify(doc);
                if (!this.baseline && !this.draft.mffSources?.length && !services.api.registry.get(this.draft.id)) {
                    this.draft.id = services.makeId(classification?.id?.split("_")[0] ?? "creature");
                    this.draft.label = doc.name;
                }
                const uuid = doc.isToken && doc.parent?.actorId ? "Actor." + doc.parent.actorId : doc.uuid;
                this.draft.mffSources ??= [];
                if (!this.draft.mffSources.some(s => s.uuid === uuid)) this.draft.mffSources.push({ uuid, name: doc.name });
            }
        } else {
            if (doc.documentName !== "Item") throw Error("Drop an item here.");
            if (target === "output" || target === "ambitiousOutput") {
                this.draft[target] = { ...this.draft[target], name: doc.name, img: doc.img,
                    description: doc.system?.description?.value ?? "", rarity: doc.system?.rarity ?? doc.system?.traits?.rarity ?? "common" };
            } else {
                const rows = this.draft[target] ??= [];
                const row = target === "ingredients" ? { name: doc.name, quantity: 1 } :
                    { name: doc.name, qty: 1, itemRef: doc.uuid, ...(doc.type === "loot" || doc.type === "equipment" ? { type: "loot" } : { foodTag: "meat", spoilsAfter: 1 }) };
                if (row.type === "loot") {
                    const gp = trophyPriceGP(doc, game.system.id);
                    if (gp !== undefined) row.mffValueGP = Math.round(gp * 100) / 100;
                }
                rows.push(row);
            }
        }
        this.markDirty();
        await this.redraw();
    }
}





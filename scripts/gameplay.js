import { FEAST_ID, MODULE_ID, escapeHTML as esc, actorKeys, findActorEntry } from "./model.js";

export function partyWithCookbookFallback(party, actors) {
    if (party.length) return party;
    return actors.filter(actor => actor.type === "character" &&
        actor.items?.some(item => item.getFlag?.(FEAST_ID, "isButcherCookbook") === true));
}

export function trophyPriceGP(item, systemId) {
    if (systemId === "pf2e") {
        const coins = item.system?.price?.value;
        if (!coins || typeof coins !== "object") return undefined;
        return Number(coins.pp ?? 0) * 10 + Number(coins.gp ?? 0) +
            Number(coins.sp ?? 0) / 10 + Number(coins.cp ?? 0) / 100;
    }
    const price = item.system?.price;
    const factor = { cp: 0.01, sp: 0.1, ep: 0.5, gp: 1, pp: 10 }[price?.denomination];
    return factor !== undefined && Number.isFinite(Number(price.value)) ? Number(price.value) * factor : undefined;
}

export function trophyPriceUpdates(actor, yields, systemId) {
    const updates = new Map();
    for (const row of yields ?? []) {
        if (row.type !== "loot" || row.mffValueGP === undefined) continue;
        const gp = Number(row.mffValueGP);
        if (!Number.isFinite(gp) || gp < 0) continue;
        for (const item of actor.items ?? []) {
            if (!["loot", "equipment"].includes(item.type) ||
                item.getFlag?.(FEAST_ID, "monsterIngredient") !== true) continue;
            const sameSource = row.itemRef && [item._stats?.compendiumSource, item.flags?.core?.sourceId].includes(row.itemRef);
            if (item.name !== row.name && !sameSource) continue;
            const price = systemId === "pf2e"
                ? { value: { cp: Math.round(gp * 100) }, per: 1 }
                : { value: gp, denomination: "gp" };
            updates.set(item.id, { _id: item.id, "system.price": price,
                ["flags." + MODULE_ID + ".trophyValueGP"]: gp });
        }
    }
    return [...updates.values()];
}

export async function applyTrophyPrices(actor, yields) {
    if (!actor?.isOwner) return;
    const updates = trophyPriceUpdates(actor, yields, game.system.id);
    if (updates.length) await actor.updateEmbeddedDocuments("Item", updates);
}

export function describeCorpse(info, linked) {
    const reasons = [];
    if (!info.isDead) reasons.push("HP is above 0");
    if (info.isPlayerCharacter) reasons.push("Treated as a player character");
    if (!info.promptOnCombatEnd) reasons.push("Automatic butcher prompts are disabled");
    if (!info.registryEntry) reasons.push(linked ? "Linked entry is below its minimum CR / level or not loaded" : "No matching butcher entry; drop this scene actor into your creature entry");
    if (!info.butchers?.length) reasons.push("No eligible butcher. Use a living character carrying a recognised Monster Cooking book");
    if (["harvested", "passed"].includes(info.butcherState)) reasons.push("Already " + info.butcherState + "; healing above 0 resets the corpse for a new test");
    if (!reasons.length) reasons.push(info.combatStarted ? "Ready for a marker; chat is offered when combat ends" : "Ready for butchering");
    return reasons;
}

export function sceneReport(api) {
    const store = api.homebrew.get();
    return (globalThis.canvas?.tokens?.placeables ?? []).map(token => {
        const info = api.inspectButcher(token);
        const linked = findActorEntry(token.actor, store.creatures);
        return {
            name: info.actorName ?? token.name,
            hp: info.hp?.value,
            link: linked?.label ?? info.registryEntry?.id ?? "No match",
            sources: actorKeys(token.actor),
            reasons: describeCorpse(info, linked),
            info
        };
    });
}

export async function showSceneCheck(api, rescan) {
    if (!game.user.isGM) return;
    const rows = sceneReport(api);
    const content = '<p>Scene token HP is used; an unlinked token can have different HP from its Actors-directory entry.</p>' +
        '<p>During active combat, Monstrous Feast shows markers and waits until combat ends to post chat offers.</p>' +
        (rows.length ? rows.map(row => '<section style="border-top:1px solid #8886;padding:10px 0"><h4>' +
            esc(row.name) + ' — HP ' + esc(row.hp) + '</h4><p><strong>Registry:</strong> ' + esc(row.link) +
            '</p><p>' + row.reasons.map(esc).join("<br>") + '</p><details><summary>Actor links</summary><p style="overflow-wrap:anywhere">' +
            row.sources.map(esc).join("<br>") + '</p></details></section>').join("") : "<p>No scene tokens found.</p>");
    await foundry.applications.api.DialogV2.wait({
        window: { title: "Monsters Feast - Scene Check" },
        position: { width: 610 },
        content,
        buttons: [
            { action: "rescan", label: "Rescan corpses", icon: "fas fa-rotate", callback: async () => {
                await rescan();
                ui.notifications.info("Scene rescanned. Reopen Scene Check for current results.");
            } },
            { action: "close", label: "Close", default: true }
        ],
        rejectClose: false
    });
}

export function installGameplayFixes({ api, DiscoveryService, GMRelay, handleGrantYieldsRelay }) {
    const originalParty = DiscoveryService.partyActors.bind(DiscoveryService);
    DiscoveryService.partyActors = () => partyWithCookbookFallback(
        originalParty(), game.actors?.contents ?? []);

    // Feast owns granting/stacking. Once it grants a trophy, apply the configured
    // per-item value to that harvested stack, without touching ordinary inventory.
    const originalResolve = api.engine.resolve;
    api.engine.resolve = async function(...args) {
        const result = await originalResolve.apply(this, args);
        if (result) {
            try { await applyTrophyPrices(args[0], result.yields); }
            catch (error) {
                console.error(MODULE_ID, error);
                ui.notifications.error("Trophies were granted, but their GP value could not be set. Edit their price in the character inventory.");
            }
        }
        return result;
    };
    GMRelay.registerHandler("grantButcherYields", async data => {
        await handleGrantYieldsRelay(data);
        try {
            const actor = data.actor ?? await fromUuid(data.actorUuid);
            await applyTrophyPrices(actor, data.yields);
        } catch (error) {
            console.error(MODULE_ID, error);
            ui.notifications.error("Trophies were granted, but their GP value could not be set. Edit their price in the character inventory.");
        }
    });

    const responsibleGM = () => {
        if (!game.user.isGM) return false;
        const active = game.users?.activeGM;
        return !active || active.id === game.user.id;
    };
    let scanQueue = Promise.resolve();
    const rescan = () => {
        if (!responsibleGM() || !globalThis.canvas?.ready) return Promise.resolve([]);
        scanQueue = scanQueue.catch(() => {}).then(() => api.scanButcherCorpses({
            createChat: !game.combat?.started, reason: MODULE_ID
        }));
        return scanQueue;
    };
    const scanSafely = () => rescan().catch(error => console.error(MODULE_ID, error));
    Hooks.on("canvasReady", scanSafely);
    Hooks.on("createItem", item => {
        if (item.parent?.documentName === "Actor" && item.getFlag?.(FEAST_ID, "isButcherCookbook")) scanSafely();
    });
    // The upstream hook reads only nested HP changes. Some update callers submit
    // flat keys; process only that shape here so normal nested updates aren't doubled.
    Hooks.on("updateActor", async (actor, changes) => {
        if (!responsibleGM() || !game.settings.get(FEAST_ID, "promptOnCombatEnd")) return;
        const hp = changes["system.attributes.hp.value"];
        if (hp === undefined || changes.system?.attributes?.hp?.value !== undefined) return;
        try {
            if (Number(hp) > 0) await api.engine.revokeButcherOffer(actor);
            else { await api.engine.onCreatureDeath(actor); await rescan(); }
        } catch (error) { console.error(MODULE_ID, error); }
    });
    // This also recovers an already-dead token after adding its registry entry.
    scanSafely();
    return { rescan, showSceneCheck: () => showSceneCheck(api, rescan) };
}


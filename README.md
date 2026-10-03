# Monsters Feast - Functionality

A GM-only visual editor for Ionrift Monstrous Feast. Requires Foundry VTT 13,
Monstrous Feast 1.1.0+ and its Ionrift Library dependency.


## Install from GitHub
In Foundry's **Install Module** dialog, use this manifest URL once the GitHub
release is published:

https://github.com/direbun/Monster-Feast-Functionality/releases/latest/download/module.json

Install Monstrous Feast and its Ionrift Library dependency, then enable
Monsters Feast - Functionality in the world. Release publishing instructions
are in [RELEASE.md](RELEASE.md).
## Enable and open
1. Reload Foundry so it reads this module's manifest.
2. Enable **Monsters Feast - Functionality** in Manage Modules.
3. Open Monstrous Feast (the /feast command) and click **Registry**.
   The **Homebrew Editor** tab and Configure Settings > Monsters Feast -
   Functionality > **Open Registry Editor** also open the editor.

## Creatures and butcher rewards
Create a creature, then drag an NPC from Actors, a compendium, or a scene into
the Creature actors area. You can link several actors to one entry. World actors
also match their scene tokens. Compendium links match imported actors through
their source UUID. Names are never used to match actors.

Add or drop items into Basic, Standard, and Exceptional rewards. Each tier is
a complete reward list, not an addition to the previous tier. Configure quantity,
food tag, spoilage rests, and optional natural-1 damage. Save before butchering.

Dropping an item records its name/reference and harvest metadata. Monstrous
Feast creates its normal food/loot yield; it does not clone arbitrary item
activities or effects. Its optional Respite integration can resolve canonical
provisions. Spoilage requires Respite.

New entries have unique IDs. Existing bundled entries can be edited as world
overrides; those category entries affect every creature already using that
classification. To create rewards only for a particular actor, use **New
creature** and drop it there instead. Duplicate clears actor links to avoid
ambiguous matches.

## Recipes and pages
Create a recipe, add ingredients by typing, dragging items, or choosing saved
butcher yields. Configure the Survival DC, standard/exceptional meals,
seasonings, success/failure narration, and supported effects. Ingredient names
must match inventory items exactly.

Linked creatures follow the existing discovery rules. Leave the selection empty
for a pantry recipe that only needs inscription. Use Ctrl-click to change multiple
selections. You can also drop a registered actor in the linked-creature area.

**Get Page** saves the current recipe and creates a real Item in the world's Items
directory. Give it to a player through the usual Foundry workflow. The existing
Monstrous Feast page handling and cookbook inscription consume the page and learn
the recipe. Repeated Get Page clicks intentionally create additional copies.

## Effects
The editor exposes all ten partyEffect fields accepted by the installed 1.1.0
homebrew validator: temporary HP, exceptional temporary HP, Strength advantage
uses, darkvision, poison resistance uses, passive Perception, Wisdom checks,
Constitution/Wisdom save advantage, and limited Constitution save bonuses.
Dice formulas such as 1d4 and @prof are supported where indicated.

Direct HP healing is not a supported field in this version of Monstrous Feast.
Effect duration, meal tier behaviour, system support, and any manual-tracking
limitations remain those of Monstrous Feast and its integrations.

## Storage and compatibility
Content lives in Monstrous Feast's world homebrew setting and survives module
updates. Export backup includes the custom actor UUID links. A different world
may need actor links recreated; compendium UUIDs must still exist.

The upstream store limits content to 50 world creatures and 50 world recipes.
The editor validates the entire prospective store before writing and refuses
lossy saves. It preserves fields it does not edit and rejects stale edits to the
same entry. Avoid simultaneous saves from multiple GM clients (Foundry settings
do not offer atomic compare-and-swap). Deleting an override restores the bundled
entry. Deleting a custom recipe leaves existing pages/inscriptions referencing
that ID; deleting a creature retains recipe links, with a warning.

The module extends Feast's runtime classification adapter only; it does not
modify the original module's files or change actors' Library classifications.
Disable this module to restore normal Feast matching. Saved recipes remain
available; custom actor-specific creature matching needs this module enabled.
Updates that move Feast's internal Library adapter or recipe-page helper will
require a compatibility update.

Source is installed directly in this module folder. No build step is needed.
Run automated checks with: node --test tests/*.test.mjs
Live Foundry gameplay should be checked with a disposable NPC and recipe before
using custom content in a session.

## Version 1.0.1: trophy prices and corpse detection

- Choose **Trophy / loot** to reveal **GP value per trophy**. Enter a fixed
  non-negative value, including zero. Leave it blank to retain the upstream
  default. Dropping an existing trophy copies its price, converting currency to GP.
- The value is written to the harvested item in the butcher's inventory, including
  GM-relayed grants. Monstrous Feast stacks trophies by name; this is the unit
  price of the resulting stack. Use different item names for different-valued
  trophies. No coins are added to a character's wallet.
- Token matching now follows the token's base actor and source provenance, including
  older compendium UUIDs. It still never matches on creature name.
- If the normal party is empty, characters carrying a flagged Monster Cooking
  book can act as the party even without player ownership. Existing party
  membership takes precedence. This supports GM-only test worlds.
- Saving a creature or adding a cookbook rescans existing corpses. Already-dead
  scene tokens can therefore become eligible without having to lose HP again.
- **Scene Check** in the editor reports token HP, matching registry entry, actor
  links, and reasons butchering is blocked. **Rescan corpses** retries detection.
  It does not reset a harvested/passed corpse or alter HP.
- During active combat the upstream engine shows corpse markers; chat offers
  wait until combat ends. The scene token's HP is authoritative, not the
  separate Actors-directory sheet for an unlinked token.

Reload the Foundry client after updating the files. These changes are covered
by automated integration tests against the installed upstream engine; the live
desktop session could not be captured for UI verification.

## Version 1.1.0: linked recipe Active Effects

Each recipe now has independent **Standard result** and **Exceptional result**
drop zones under **Linked Active Effects**.

1. Create/configure Active Effects on an item, including an item in a compendium.
2. Drop an effect into the required result. If the item sheet doesn't let you
   drag individual effects, drop the item itself to copy all its effects, then
   remove any unwanted copies.
3. Save the recipe. Serve a successful meal through the normal cookbook flow.
   The party receives the effects from the actual result's list.

Exceptional results use ONLY the exceptional list: they do not automatically
include the standard list. **Copy standard to exceptional** provides an explicit
starting point. You can use multiple effects per list (up to 20).

The recipe saves a snapshot of each effect. Removing or moving the source
doesn't break existing recipes. **Open source** opens the original effect sheet;
**Refresh copy** replaces the saved copy with the source's current configuration.
Drop the effect again if its UUID changed. Homebrew export includes the copies.

Application happens when the food is served, not when ingredients are selected
or a failed cooking roll occurs. Effects are enabled on the recipient actors
with item transfer disabled, retaining effect changes, statuses and module
flags. Duration clocks restart at serving time. The source item is not consumed
or modified, and its activities are not executed.

DAE special durations, Convenient Effects metadata, aura flags and macro
configuration are retained. Their behaviour still requires the appropriate
modules and a correctly configured effect. This is a native Active Effect bridge,
not a replacement for those modules' engines or an item-use workflow. Features
that require an owned source item or a particular macro context may need source
effect adjustments. Linked Active Effects currently target D&D 5e; PF2e rule
elements are not converted.

A later served meal replaces previous linked recipe effects, including when
the later result's list is empty. Unrelated actor effects are preserved. Built-in
Monstrous Feast buffs continue to follow their existing rules. Long rests also
clear linked effects by default; uncheck **Remove linked effects on a long rest**
to leave expiry to the effect's configured duration/automation. Native timed
expiration depends on your system and automation stack, as with other effects.

Player serving uses the existing GM relay. The GM resolves effects from the
saved recipe and selects current party recipients; effect data supplied by a
requesting client is not used. Applying to nonowned party members requires a
connected GM. Already-served meals are not retroactively changed when a recipe
is edited.

Verification: automated tests exercise the installed MealService serving path,
both tiers, item/effect drops, saved copies, flags-only aura effects, replacement,
long-rest cleanup and GM relay. Live DAE/Convenient Effects/aura behaviour has
not been verified in the open Foundry session.


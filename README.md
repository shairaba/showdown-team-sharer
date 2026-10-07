# Showdown Team Sharer

Chrome extension that restores the "upload to Pokepast.es" button the new
Pokémon Showdown teambuilder removed, and adds the same for VRPastes
(as either an Open Team Sheet or a full paste).

## How it works

- Content script watches the teambuilder for an open team panel
  (`#room-team-*`) and adds a row of buttons under the "Team name" field.
- Clicking a button asks the background service worker to run a small
  function inside the Showdown page itself (`window.PS.rooms[roomId].editor
  .export(true)`), which is the client's own official team-exporter — the
  same text its own "[Copy]" button copies. This means the extension never
  has to duplicate Showdown's Pokédex/move/item data, and stays accurate
  automatically as they update the game data.
- The background service worker then makes the actual POST request
  (to `pokepast.es/create` or VRPastes' API) and opens the new paste in a
  tab. This has to happen in the background, not the content script/page,
  because extensions with `host_permissions` bypass the CORS restrictions
  that would otherwise block a cross-origin POST from the page.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Turn on "Developer mode" (top right).
3. Click "Load unpacked" and select this folder.
4. Go to https://play.pokemonshowdown.com/teambuilder, open any team, and
   you'll see the new buttons under the team name field.
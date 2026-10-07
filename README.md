# Showdown Team Sharer

Chrome extension that restores the "upload to Pokepast.es" button the new
Pokémon Showdown teambuilder removed, and adds the same for VRPastes
(as either an Open Team Sheet or a full paste) and PokeBin (optionally
password-protected).

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
  (to `pokepast.es/create`, VRPastes' API, or `pokebin.com/create`) and opens
  the new paste in a tab. This has to happen in the background, not the
  content script/page, because extensions with `host_permissions` bypass the
  CORS restrictions that would otherwise block a cross-origin POST from the
  page.

## PokeBin password protection

PokeBin pastes can optionally be encrypted with a password. Their scheme
(see `github.com/malaow3/PokeBin`, `wasm/crypto.zig`) is Argon2id for key
derivation, then AES-256 in a raw counter mode they label "gcm" (it isn't
actual AES-GCM: the "tag" is just `AES(key, 0-block)` XORed into the first
16 bytes of ciphertext, not a real MAC over the whole message).

While implementing this I found that PokeBin's own WASM module has a bug:
its Zig `init()` stores a pointer to a local stack variable
(`rand = &rand_inst`) that's gone by the time it's read back, so the random
salt/nonce it generates come out all-zero every time — confirmed by running
their published WASM binary directly. That makes the derived key
deterministic per password and reuses the same keystream across every paste
encrypted with that password, which breaks confidentiality if a password is
ever reused on their site.

[background.js](background.js) reimplements their exact construction in JS
(Argon2id via a vendored [hash-wasm](https://github.com/Daninet/hash-wasm)
build, AES-CTR via the Web Crypto API) but generates real random salt/nonce
with `crypto.getRandomValues()`. Decryption only reads the salt/nonce from
the string itself, so this stays fully compatible with pokebin.com's own
decryptor — verified by round-tripping against their actual published WASM
module in both directions — without inheriting the vulnerability.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Turn on "Developer mode" (top right).
3. Click "Load unpacked" and select this folder.
4. Go to https://play.pokemonshowdown.com/teambuilder, open any team, and
   you'll see the new buttons under the team name field.
// Showdown Team Sharer - background service worker
//
// Responsibilities:
//  1. Reach into the Pokémon Showdown page's own JS (the "MAIN" world) to read
//     the currently-open team via window.PS, using the client's own exporter
//     (PS.rooms[roomId].editor.export(true)) so we never have to duplicate its
//     Pokédex/move/item data ourselves.
//  2. Make the actual cross-origin POST requests to Pokepast.es / VRPastes /
//     PokeBin. This has to happen here (not in the content script) because
//     extensions with host_permissions bypass normal CORS restrictions, while
//     the page's own fetch()/form POSTs would be subject to the target site's
//     CORS policy.
//  3. For PokeBin's password-protected pastes, encrypt client-side using the
//     same construction as PokeBin's own code (Argon2id -> AES-256-CTR, see
//     deriveKey()/pokebinEncrypt() below) so the result opens correctly on
//     pokebin.com. See the long comment above pokebinEncrypt() for why this
//     is a local reimplementation rather than a call into PokeBin's own WASM.

importScripts('vendor/argon2.umd.min.js'); // exposes self.hashwasm.argon2id

const POKEPASTE_CREATE_URL = 'https://pokepast.es/create';
const VRPASTES_API_URL = 'https://vrpaste-backend.vercel.app/api/paste';
const VRPASTES_SITE = 'https://www.vrpastes.com';
const POKEBIN_CREATE_URL = 'https://pokebin.com/create';

// Runs inside the page itself (MAIN world), not the content script's isolated
// world, so it must be fully self-contained (no references to outer scope).
function extractTeamFromPage(roomId) {
  try {
    const PS = window.PS;
    if (!PS || !PS.rooms) {
      return { ok: false, error: 'Could not find the Pokémon Showdown client on this page (window.PS is missing).' };
    }
    const room = PS.rooms[roomId];
    if (!room) {
      return { ok: false, error: 'This team panel is no longer open. Re-open the team and try again.' };
    }
    const editor = room.editor;
    if (!editor || typeof editor.export !== 'function') {
      return { ok: false, error: 'The team editor is not ready yet. Click into the team and try again.' };
    }
    const raw = editor.export(true);
    if (!raw || !raw.trim()) {
      return { ok: false, error: 'Add at least one Pokémon to the team before sharing it.' };
    }
    const team = (room.getTeam && room.getTeam()) || room.team || null;
    return {
      ok: true,
      raw,
      name: (team && team.name) || '',
      format: (team && team.format) || '',
      username: (PS.user && PS.user.name) || '',
    };
  } catch (err) {
    return { ok: false, error: 'Unexpected error reading the team: ' + (err && err.message ? err.message : String(err)) };
  }
}

async function readTeam(tabId, roomId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: extractTeamFromPage,
    args: [roomId],
  });
  const result = results && results[0] && results[0].result;
  return result || { ok: false, error: 'Could not read the team from the page.' };
}

async function uploadToPokepaste({ raw, name, format, username }) {
  const body = new URLSearchParams();
  body.set('title', name || 'Untitled team');
  body.set('paste', raw);
  body.set('author', username || '');
  if (format && format !== 'gen9') body.set('notes', `Format: ${format}`);

  let res;
  try {
    res = await fetch(POKEPASTE_CREATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (err) {
    return { ok: false, error: 'Network error contacting Pokepast.es: ' + err.message };
  }

  // pokepast.es/create responds 303 -> the new paste URL; fetch follows the
  // redirect automatically, so res.url is already the final paste link.
  if (!res.ok) {
    return { ok: false, error: `Pokepast.es returned an error (HTTP ${res.status}).` };
  }
  return { ok: true, url: res.url };
}

function deriveVrpastesUrl(data) {
  if (!data || typeof data !== 'object') return null;
  if (typeof data.url === 'string') return data.url;
  const id = data.id || data.slug || data.paste_id || data.pasteId ||
    (data.data && (data.data.id || data.data.slug));
  return id ? `${VRPASTES_SITE}/${id}` : null;
}

async function uploadToVrpastes({ raw, isPublic }) {
  let res;
  let text;
  try {
    res = await fetch(VRPASTES_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw, is_public: !!isPublic }),
    });
    text = await res.text();
  } catch (err) {
    return { ok: false, error: 'Network error contacting VRPastes: ' + err.message };
  }

  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* leave data null */ }

  if (!res.ok) {
    const detail = (data && (data.error || data.message)) || text.slice(0, 200) || `HTTP ${res.status}`;
    return { ok: false, error: `VRPastes returned an error: ${detail}` };
  }

  const url = deriveVrpastesUrl(data);
  if (!url) {
    return {
      ok: true,
      url: null,
      warning: "Paste was created, but the extension couldn't figure out its URL from the server's response.",
      raw: data,
    };
  }
  return { ok: true, url };
}

// --- PokeBin password encryption ---
//
// PokeBin's own password protection (see github.com/malaow3/PokeBin,
// wasm/crypto.zig) derives a key with Argon2id and encrypts with AES-256 in
// a raw counter mode it labels "gcm" (it isn't actually GCM: the "tag" is
// just AES(key, 0-block) XORed into the first 16 bytes of ciphertext, not a
// real GMAC/HMAC over the whole message). The output format is
// "gcm:<salt hex>:<nonce hex>:<ciphertext+tag hex>".
//
// Their WASM module's random salt/nonce generation has a real bug: its Zig
// `init()` stores a pointer to a local stack variable (`rand = &rand_inst`)
// that's gone by the time it's read back, so the salt and nonce it produces
// come out all-zero every time (confirmed by running their published WASM
// binary directly - see https://pokebin.com/wasm). That makes the derived
// key deterministic per-password and reuses the same CTR keystream across
// every paste encrypted with that password, which breaks confidentiality if
// a password is ever reused. Calling into their WASM would inherit that bug.
//
// Decryption only reads the salt/nonce from the string, so a real random
// salt/nonce here is fully compatible with pokebin.com's own decryptor while
// not inheriting the vulnerability. This was verified by round-tripping
// against PokeBin's actual published WASM module in both directions before
// wiring it in here.
const POKEBIN_ARGON2_PARALLELISM = 2;
const POKEBIN_ARGON2_ITERATIONS = 1;
const POKEBIN_ARGON2_MEMORY_KIB = 32 * 1024;
const POKEBIN_KEY_LENGTH = 32;

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function pokebinDeriveKey(passphrase, salt) {
  const keyBytes = await self.hashwasm.argon2id({
    password: passphrase,
    salt,
    parallelism: POKEBIN_ARGON2_PARALLELISM,
    iterations: POKEBIN_ARGON2_ITERATIONS,
    memorySize: POKEBIN_ARGON2_MEMORY_KIB,
    hashLength: POKEBIN_KEY_LENGTH,
    outputType: 'binary',
  });
  return crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CTR' }, false, ['encrypt']);
}

async function pokebinAesCtr(key, counter, data) {
  const out = await crypto.subtle.encrypt({ name: 'AES-CTR', counter, length: 128 }, key, data);
  return new Uint8Array(out);
}

async function pokebinEncrypt(message, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await pokebinDeriveKey(passphrase, salt);

  const counter = new Uint8Array(16);
  counter.set(nonce, 0);
  const messageBytes = new TextEncoder().encode(message);
  const ciphertext = await pokebinAesCtr(key, counter, messageBytes);

  // tag = AES_encrypt(key, 0-block) XOR ciphertext[:16], matching PokeBin's
  // "simplified GMAC". AES-CTR of a zero counter over a zero-block plaintext
  // gives exactly AES_encrypt(key, 0) without needing a separate ECB call.
  const aesOfZero = await pokebinAesCtr(key, new Uint8Array(16), new Uint8Array(16));
  const tag = aesOfZero.slice();
  for (let j = 0; j < 16 && j < ciphertext.length; j++) tag[j] ^= ciphertext[j];

  const combined = new Uint8Array(ciphertext.length + 16);
  combined.set(ciphertext, 0);
  combined.set(tag, ciphertext.length);

  return `gcm:${bytesToHex(salt)}:${bytesToHex(nonce)}:${bytesToHex(combined)}`;
}

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async function uploadToPokebin({ raw, name, format, username, password }) {
  const baseData = {
    title: name || '',
    author: username || '',
    notes: '',
    format: format || '',
    rental: '',
    content: raw,
  };

  let formPayload;
  if (password) {
    let encryptedStr;
    try {
      encryptedStr = await pokebinEncrypt(JSON.stringify(baseData), password);
    } catch (err) {
      return { ok: false, error: 'Failed to encrypt the paste: ' + err.message };
    }
    formPayload = { encrypted: true, data: encryptedStr };
  } else {
    formPayload = { encrypted: false, data: baseData };
  }

  const encoded = utf8ToBase64(JSON.stringify(formPayload));

  let res;
  try {
    res = await fetch(POKEBIN_CREATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(encoded),
    });
  } catch (err) {
    return { ok: false, error: 'Network error contacting PokeBin: ' + err.message };
  }

  // PokeBin's /create responds 302 -> /<uuid>; fetch follows it, so res.url
  // is already the final paste link.
  if (!res.ok) {
    return { ok: false, error: `PokeBin returned an error (HTTP ${res.status}).` };
  }
  return { ok: true, url: res.url };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'teamSharer:upload') return undefined;

  (async () => {
    const tabId = sender.tab && sender.tab.id;
    if (!tabId) {
      sendResponse({ ok: false, error: 'No active tab found.' });
      return;
    }

    const team = await readTeam(tabId, msg.roomId);
    if (!team.ok) {
      sendResponse(team);
      return;
    }

    let result;
    if (msg.target === 'pokepaste') {
      result = await uploadToPokepaste(team);
    } else if (msg.target === 'vrpastes') {
      result = await uploadToVrpastes({ raw: team.raw, isPublic: msg.isPublic });
    } else if (msg.target === 'pokebin') {
      result = await uploadToPokebin({ ...team, password: msg.password });
    } else {
      result = { ok: false, error: 'Unknown upload target: ' + msg.target };
    }

    if (result.ok && result.url) {
      try {
        await chrome.tabs.create({ url: result.url });
      } catch {
        // Non-fatal: the content script will still show the link.
      }
    }
    sendResponse(result);
  })();

  return true; // keep the message channel open for the async response
});

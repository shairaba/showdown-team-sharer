// Showdown Team Sharer - background service worker
//
// Responsibilities:
//  1. Reach into the Pokémon Showdown page's own JS (the "MAIN" world) to read
//     the currently-open team via window.PS, using the client's own exporter
//     (PS.rooms[roomId].editor.export(true)) so we never have to duplicate its
//     Pokédex/move/item data ourselves.
//  2. Make the actual cross-origin POST requests to Pokepast.es / VRPastes.
//     This has to happen here (not in the content script) because extensions
//     with host_permissions bypass normal CORS restrictions, while the page's
//     own fetch()/form POSTs would be subject to the target site's CORS policy.

const POKEPASTE_CREATE_URL = 'https://pokepast.es/create';
const VRPASTES_API_URL = 'https://vrpaste-backend.vercel.app/api/paste';
const VRPASTES_SITE = 'https://www.vrpastes.com';

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

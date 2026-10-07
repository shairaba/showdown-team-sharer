// Showdown Team Sharer - content script
//
// Watches the teambuilder for an open team-edit panel (DOM id "room-team-*",
// matching Pokémon Showdown's own room id scheme of "team-<key>") and injects
// a row of share buttons under the "Team name" field. The actual team data
// extraction and network requests happen in background.js.

const BUTTONS = [
  { target: 'pokepaste', label: 'Upload to Pokepast.es', icon: 'fa-upload' },
  { target: 'vrpastes', isPublic: true, label: 'Share Open Team Sheet to VRPastes', icon: 'fa-eye' },
  { target: 'vrpastes', isPublic: false, label: 'Share Full Paste to VRPastes', icon: 'fa-lock' },
];

function buildButtonRow(panelEl) {
  const row = document.createElement('div');
  row.className = 'team-pad team-sharer-row';

  const label = document.createElement('div');
  label.className = 'team-sharer-label';
  label.textContent = 'Share team:';
  row.appendChild(label);

  const buttonWrap = document.createElement('p');
  for (const cfg of BUTTONS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'button team-sharer-btn';
    btn.innerHTML = `<i class="fa ${cfg.icon}" aria-hidden="true"></i> ${cfg.label}`;
    btn.addEventListener('click', () => handleClick(btn, panelEl, cfg));
    buttonWrap.appendChild(btn);
    buttonWrap.appendChild(document.createTextNode(' '));
  }
  row.appendChild(buttonWrap);

  const status = document.createElement('div');
  status.className = 'team-sharer-status';
  row.appendChild(status);

  return row;
}

async function handleClick(button, panelEl, cfg) {
  const roomId = panelEl.id.replace(/^room-/, '');
  const row = button.closest('.team-sharer-row');
  const status = row.querySelector('.team-sharer-status');
  const originalText = button.innerHTML;

  setRowDisabled(row, true);
  button.innerHTML = `<i class="fa fa-spinner fa-pulse" aria-hidden="true"></i> Uploading…`;
  setStatus(status, '', null);

  try {
    const res = await chrome.runtime.sendMessage({
      type: 'teamSharer:upload',
      target: cfg.target,
      isPublic: cfg.isPublic,
      roomId,
    });

    if (res && res.ok && res.url) {
      button.innerHTML = `<i class="fa fa-check" aria-hidden="true"></i> Done!`;
      setStatus(status, `Uploaded: ${res.url}`, 'success');
      tryCopyToClipboard(res.url);
    } else if (res && res.ok && !res.url) {
      button.innerHTML = `<i class="fa fa-check" aria-hidden="true"></i> Uploaded`;
      setStatus(status, res.warning || 'Uploaded, but the link could not be determined automatically.', 'warn');
    } else {
      button.innerHTML = `<i class="fa fa-times" aria-hidden="true"></i> Failed`;
      setStatus(status, (res && res.error) || 'Unknown error uploading the team.', 'error');
    }
  } catch (err) {
    button.innerHTML = `<i class="fa fa-times" aria-hidden="true"></i> Failed`;
    setStatus(status, err && err.message ? err.message : String(err), 'error');
  } finally {
    setRowDisabled(row, false);
    setTimeout(() => { button.innerHTML = originalText; }, 2500);
  }
}

function setRowDisabled(row, disabled) {
  row.querySelectorAll('button').forEach(b => { b.disabled = disabled; });
}

function setStatus(statusEl, text, kind) {
  statusEl.textContent = text;
  statusEl.className = 'team-sharer-status' + (kind ? ` team-sharer-status-${kind}` : '');
}

function tryCopyToClipboard(text) {
  try {
    navigator.clipboard.writeText(text).catch(() => {});
  } catch {
    // ignore - clipboard access isn't essential
  }
}

function processPanel(panelEl) {
  if (panelEl.dataset.teamSharerInjected) return;
  const teamNameLabel = panelEl.querySelector('.teamname');
  if (!teamNameLabel) return; // not fully rendered yet; retry on next mutation

  const headerPad = teamNameLabel.closest('.team-pad');
  if (!headerPad) return;

  panelEl.dataset.teamSharerInjected = '1';
  headerPad.insertAdjacentElement('afterend', buildButtonRow(panelEl));
}

function scanForPanels(root) {
  if (root.matches && root.matches('[id^="room-team-"]')) {
    processPanel(root);
  }
  root.querySelectorAll && root.querySelectorAll('[id^="room-team-"]').forEach(processPanel);
}

const observer = new MutationObserver(mutations => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node.nodeType === Node.ELEMENT_NODE) scanForPanels(node);
    }
    // The team-name field (and thus our insertion point) can appear slightly
    // after the panel container itself, so also re-check on attribute/text
    // changes within already-seen panels that we haven't injected into yet.
    if (mutation.target && mutation.target.nodeType === Node.ELEMENT_NODE) {
      const panel = mutation.target.closest && mutation.target.closest('[id^="room-team-"]');
      if (panel && !panel.dataset.teamSharerInjected) processPanel(panel);
    }
  }
});

observer.observe(document.documentElement, { childList: true, subtree: true });
scanForPanels(document.documentElement);

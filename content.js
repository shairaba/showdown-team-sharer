// Showdown Team Sharer - content script
//
// Watches the teambuilder for an open team-edit panel (DOM id "room-team-*",
// matching Pokémon Showdown's own room id scheme of "team-<key>") and injects
// a row of share controls under the "Team name" field. The actual team data
// extraction and network requests happen in background.js.
//
// Pokepast.es is a single immediate-action button. VRPastes and PokeBin use
// a <details>/<summary> dropdown (the same pattern Showdown's own "[Options]"
// menu uses) since they each need a small bit of input before uploading.

function buildButtonRow(panelEl) {
  const row = document.createElement('div');
  row.className = 'team-pad team-sharer-row';

  const label = document.createElement('div');
  label.className = 'team-sharer-label';
  label.textContent = 'Share team:';
  row.appendChild(label);

  const buttonWrap = document.createElement('p');
  const vrpastesDropdown = buildVrpastesDropdown(panelEl);
  const pokebinDropdown = buildPokebinDropdown(panelEl);
  buttonWrap.appendChild(buildPokepasteButton(panelEl));
  buttonWrap.appendChild(document.createTextNode(' '));
  buttonWrap.appendChild(vrpastesDropdown);
  buttonWrap.appendChild(document.createTextNode(' '));
  buttonWrap.appendChild(pokebinDropdown);
  row.appendChild(buttonWrap);

  // Keep at most one dropdown open at a time.
  for (const details of [vrpastesDropdown, pokebinDropdown]) {
    details.addEventListener('toggle', () => {
      if (!details.open) return;
      for (const other of [vrpastesDropdown, pokebinDropdown]) {
        if (other !== details) other.open = false;
      }
    });
  }

  const status = document.createElement('div');
  status.className = 'team-sharer-status';
  row.appendChild(status);

  return row;
}

function buildPokepasteButton(panelEl) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'button team-sharer-btn';
  btn.innerHTML = `<i class="fa fa-upload" aria-hidden="true"></i> Upload to Pokepast.es`;
  btn.addEventListener('click', () => {
    runUpload(panelEl, btn, [{ target: 'pokepaste', label: 'Pokepast.es' }]);
  });
  return btn;
}

function buildVrpastesDropdown(panelEl) {
  const details = document.createElement('details');
  details.className = 'team-sharer-dropdown';

  const summary = document.createElement('summary');
  summary.className = 'button team-sharer-btn';
  summary.innerHTML = `<i class="fa fa-share-alt" aria-hidden="true"></i> Share to VRPastes ▾`;
  details.appendChild(summary);

  const menu = document.createElement('div');
  menu.className = 'team-sharer-dropdown-menu';

  const otsCheckbox = document.createElement('input');
  otsCheckbox.type = 'checkbox';
  const otsLabel = document.createElement('label');
  otsLabel.className = 'checkbox';
  otsLabel.appendChild(otsCheckbox);
  otsLabel.appendChild(document.createTextNode(' Open Team Sheet'));

  const fullCheckbox = document.createElement('input');
  fullCheckbox.type = 'checkbox';
  const fullLabel = document.createElement('label');
  fullLabel.className = 'checkbox';
  fullLabel.appendChild(fullCheckbox);
  fullLabel.appendChild(document.createTextNode(' Full Paste'));

  const shareBtn = document.createElement('button');
  shareBtn.type = 'button';
  shareBtn.className = 'button';
  shareBtn.textContent = 'Share';

  menu.appendChild(otsLabel);
  menu.appendChild(fullLabel);
  menu.appendChild(shareBtn);
  details.appendChild(menu);

  shareBtn.addEventListener('click', () => {
    const jobs = [];
    if (otsCheckbox.checked) jobs.push({ target: 'vrpastes', isPublic: true, label: 'VRPastes (OTS)' });
    if (fullCheckbox.checked) jobs.push({ target: 'vrpastes', isPublic: false, label: 'VRPastes (Full)' });
    if (!jobs.length) {
      const row = details.closest('.team-sharer-row');
      renderStatusLines(row.querySelector('.team-sharer-status'), [
        { text: 'Check Open Team Sheet, Full Paste, or both.', kind: 'error' },
      ]);
      return;
    }
    details.open = false;
    runUpload(panelEl, summary, jobs);
  });

  return details;
}

function buildPokebinDropdown(panelEl) {
  const details = document.createElement('details');
  details.className = 'team-sharer-dropdown';

  const summary = document.createElement('summary');
  summary.className = 'button team-sharer-btn';
  summary.innerHTML = `<i class="fa fa-upload" aria-hidden="true"></i> Upload to PokeBin ▾`;
  details.appendChild(summary);

  const menu = document.createElement('div');
  menu.className = 'team-sharer-dropdown-menu';

  const passwordInput = document.createElement('input');
  passwordInput.type = 'password';
  passwordInput.className = 'textbox team-sharer-password';
  passwordInput.placeholder = 'Password (optional) — press Enter';
  passwordInput.autocomplete = 'off';
  menu.appendChild(passwordInput);
  details.appendChild(menu);

  details.addEventListener('toggle', () => {
    if (details.open) passwordInput.focus();
  });

  passwordInput.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') {
      details.open = false;
      return;
    }
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    const password = passwordInput.value;
    passwordInput.value = ''; // don't leave the plaintext sitting in the DOM
    details.open = false;
    runUpload(panelEl, summary, [{ target: 'pokebin', password, label: 'PokeBin' }]);
  });

  return details;
}

async function runUpload(panelEl, triggerEl, jobs) {
  const roomId = panelEl.id.replace(/^room-/, '');
  const row = triggerEl.closest('.team-sharer-row');
  const status = row.querySelector('.team-sharer-status');
  const originalHTML = triggerEl.innerHTML;

  setRowDisabled(row, true);
  triggerEl.innerHTML = `<i class="fa fa-spinner fa-pulse" aria-hidden="true"></i> Uploading…`;
  renderStatusLines(status, []);

  const lines = [];
  for (const job of jobs) {
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'teamSharer:upload',
        target: job.target,
        isPublic: job.isPublic,
        password: job.password,
        roomId,
      });

      if (res && res.ok && res.url) {
        lines.push({ text: `${job.label}: ${res.url}`, kind: 'success' });
        tryCopyToClipboard(res.url);
      } else if (res && res.ok && !res.url) {
        lines.push({
          text: `${job.label}: ${res.warning || 'Uploaded, but the link could not be determined automatically.'}`,
          kind: 'warn',
        });
      } else {
        lines.push({ text: `${job.label}: ${(res && res.error) || 'Unknown error uploading the team.'}`, kind: 'error' });
      }
    } catch (err) {
      lines.push({ text: `${job.label}: ${err && err.message ? err.message : String(err)}`, kind: 'error' });
    }
  }

  renderStatusLines(status, lines);
  setRowDisabled(row, false);
  setTimeout(() => { triggerEl.innerHTML = originalHTML; }, 2500);
}

function setRowDisabled(row, disabled) {
  row.querySelectorAll('button, input').forEach(el => { el.disabled = disabled; });
}

function renderStatusLines(statusEl, lines) {
  statusEl.textContent = '';
  statusEl.className = 'team-sharer-status';
  for (const line of lines) {
    const div = document.createElement('div');
    div.className = `team-sharer-status-line team-sharer-status-${line.kind}`;
    div.textContent = line.text;
    statusEl.appendChild(div);
  }
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

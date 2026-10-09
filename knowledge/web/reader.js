'use strict';
const $ = selector => document.querySelector(selector);
const svgNS = 'http://www.w3.org/2000/svg';
const topics = ['Mind & body', 'Business & money', 'Work & ambition', 'Life & perspective', 'World & society'];
const storageKey = 'figuring-out.collections.v1';
const guestMode = document.documentElement.dataset.accounts === 'guest';
const accountRequired = guestMode || document.documentElement.dataset.accounts === 'required';
let account = null, collectionRevision = 0, collectionsReady = !accountRequired;
let collectionLoadVersion = 0, collectionSaving = false;
const collectionChannel = accountRequired && typeof BroadcastChannel === 'function'
  ? new BroadcastChannel('figuring-out.collections.changed') : null;
let catalog = [], status = null, view = 'discover', topic = '', query = '', visibleCount = 12;
let collections = [], currentCollection = '', pendingSave = null, busy = false, historyOffset = 0;
let toastTimer, statusTimer, lastFocused = null;
let answerRoute = 'answer', lastQuestion = null, navigationVersion = 0;
let historyVersion = 0, statusVersion = 0;
let savedTab = 'collections', moveFromCollection = '', editingCollection = null, pendingImport = null;
let activeRequest = null, playerSession = null, youtubeReady = null;
let accountRedirecting = false;
const dialogReturnFocus = new WeakMap();

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function icon(name) {
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'icon'); svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(svgNS, 'use'); use.setAttribute('href', '#i-' + name); svg.append(use);
  return svg;
}
function button(label, className, callback, iconName) {
  const node = el('button', className, label); node.type = 'button';
  if (iconName) node.append(icon(iconName));
  node.addEventListener('click', callback); return node;
}
function iconButton(label, name, callback) {
  const node = button('', 'icon-button', callback, name); node.setAttribute('aria-label', label); return node;
}
function external(label, url) {
  const a = el('a', 'text-link', label); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
  a.addEventListener('click', stopVideo); a.append(icon('up')); return a;
}
function videoID(item) { return item?.source_id || item?.id || ''; }
function validID(id) { return typeof id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(id); }
function fullVideoURL(item) {
  const id = videoID(item);
  return validID(id) ? `https://www.youtube.com/watch?v=${id}` : '';
}
function timeLabel(value) { const s = Math.floor(Math.max(0, Number(value) || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
function clipKey(item) {
  return validID(videoID(item)) && Number.isFinite(item?.start) && item.start >= 0 && Number.isFinite(item.end) && item.end > item.start
    ? `${videoID(item)}:${item.start}:${item.end}` : '';
}
function clipRange(item) { return `${timeLabel(item.start)}–${timeLabel(Math.ceil(item.end))}`; }
function findVideo(id) { return catalog.find(v => v.id === id) || readyVideos().find(v => v.id === id); }
function readyVideos() { return (status?.sources || []).filter(v => v.state === 'ready' || v.status === 'ready'); }
function canAnswer() { return Boolean(status?.credentials?.answers && readyVideos().length); }
function toast(message, actions = []) {
  clearTimeout(toastTimer);
  const notice = $('#toast');
  const text = el('span', '', message); text.setAttribute('role', 'status');
  notice.replaceChildren(text); notice.hidden = false;
  actions.forEach(action => notice.append(button(action.label, 'toast-action', async event => {
    event.currentTarget.disabled = true;
    try { await action.run(); } catch { toast('This change could not finish. Please try again.'); }
    finally { if (event.target.isConnected) event.target.disabled = false; }
  })));
  if (actions.length) notice.append(iconButton('Dismiss notification', 'close', () => { notice.hidden = true; }));
  else toastTimer = setTimeout(() => { notice.hidden = true; }, 6000);
}
function accountHeaders(extra = {}) {
  return {...extra, ...(accountRequired && account ? {'X-Account-ID': account.id, 'X-CSRF-Token': account.csrf} : {})};
}
function leaveAccount(redirect = '/sign-in?next=' + encodeURIComponent('/' + location.hash)) {
  if (accountRedirecting) return;
  accountRedirecting = true;
  // Hide before navigation so another account never sees a cached private view.
  document.body.hidden = true;
  if (activeRequest) { activeRequest.cancelled = true; activeRequest.controller.abort(); }
  stopVideo(); clearInterval(statusTimer);
  historyVersion++; collectionLoadVersion++; navigationVersion++;
  location.replace(redirect);
}
function checkSessionResponse(response, result) {
  if (accountRequired && !guestMode && (response.status === 401 || result.code === 'session_changed')) leaveAccount();
}
async function checkCurrentAccount() {
  if (!accountRequired || !account || accountRedirecting) return;
  try {
    const fresh = await api('/api/account');
    if (fresh.id !== account.id || fresh.csrf !== account.csrf) {
      if (guestMode) location.reload(); else leaveAccount();
      return;
    }
    syncCollections(true);
  } catch (error) { if (guestMode && error.status === 401) location.reload(); }
}
async function api(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(path, {...options, headers: accountHeaders(options.headers), signal: controller.signal}); const result = await response.json();
    if (!response.ok) {
      checkSessionResponse(response, result);
      const error = new Error(result.error || 'The library could not be reached. Please try again.');
      error.status = response.status; throw error;
    }
    return result;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('The library took too long to respond. Please try again.');
    throw error;
  } finally { clearTimeout(timeout); }
}
function imageFor(item, alt = '') {
  const image = el('img'); image.alt = alt; image.loading = 'lazy';
  image.src = item.quote && findVideo(videoID(item))?.portrait || `https://i.ytimg.com/vi/${videoID(item)}/hqdefault.jpg`;
  image.addEventListener('error', () => {
    image.src = '/favicon.svg'; image.classList.add('image-unavailable');
    image.alt = alt ? `${alt} — thumbnail unavailable` : '';
  }, {once: true});
  return image;
}
function itemKey(item) {
  const moment = item.kind === 'moment' || typeof item.quote === 'string';
  return `${videoID(item)}:${moment ? `${Number(item.start) || 0}:${Number(item.end) || 0}` : 'episode'}`;
}
function saveButton(item, label, collectionId = '') {
  const node = iconButton(label, 'save', () => quickSave(item, collectionId));
  node.dataset.saveLabel = label;
  node.dataset.saveKey = itemKey(item); markSaved(node); return node;
}
function markSaved(node) {
  const key = node.dataset.saveKey;
  const names = collections.filter(c => c.items.some(item => itemKey(item) === key)).map(c => c.name);
  node.setAttribute('aria-pressed', String(Boolean(names.length)));
  node.title = names.length ? `Saved in ${names.join(', ')}. Change collection` : 'Save to Watch later';
  node.setAttribute('aria-label', names.length ? `Saved in ${names.join(', ')}. Change collection` : node.dataset.saveLabel || 'Save to Watch later');
  node.disabled = collectionSaving || !collectionsReady;
}
function updateSaveButtons() {
  document.querySelectorAll('[data-save-key]').forEach(markSaved);
  document.querySelectorAll('.remove-save, #new-collection, #rename-collection, #delete-collection, #import-collections, #export-collections').forEach(node => { node.disabled = collectionSaving || !collectionsReady; });
}
function savedItem(item) {
  const id = videoID(item);
  if (!validID(id)) throw new Error('This conversation cannot be saved.');
  const kind = item.kind === 'moment' || typeof item.quote === 'string' ? 'moment' : 'episode';
  const value = {id, title: String(item.title || item.display_title || 'Conversation').slice(0, 700), kind};
  if (kind === 'moment') {
    value.start = Math.max(0, Number(item.start) || 0); value.end = Math.max(value.start, Number(item.end) || value.start);
    value.quote = String(item.quote || '').slice(0, 30000);
  }
  for (const [field, max] of [['clip_title', 80], ['summary', 400]]) {
    if (typeof item[field] === 'string' && item[field].trim()) value[field] = item[field].slice(0, max);
  }
  return value;
}
function loadCollections() {
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw === null) return [{id: 'watch-later', name: 'Watch later', items: []}];
    const rows = JSON.parse(raw);
    if (!Array.isArray(rows) || rows.length > 100) throw new Error('Invalid collections');
    return rows.filter(c => c && typeof c.id === 'string' && typeof c.name === 'string' && Array.isArray(c.items))
      .map(c => ({id: c.id.slice(0, 80), name: c.name.slice(0, 60), items: c.items.filter(v => v && validID(v.id)).slice(0, 200).map(savedItem)}));
  } catch {
    toast('Your saved collections could not be read. Browser storage may be unavailable.');
    return [{id: 'watch-later', name: 'Watch later', items: []}];
  }
}
async function persist(next) {
  if (collectionSaving) return false;
  collectionSaving = true; collectionLoadVersion++; updateSaveButtons();
  try {
    if (accountRequired) {
      if (!account || !collectionsReady) { toast('Reload your collections before saving changes.'); return false; }
      try {
        const result = await api('/api/collections', {method: 'PUT', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({revision: collectionRevision, items: next})});
        collectionRevision = result.revision; collections = result.items; updateCollectionCount();
        collectionChannel?.postMessage({owner: account.id}); return true;
      } catch (error) {
        if (error.status === 409) {
          collectionsReady = false;
          collectionSaving = false;
          try { await refreshCollections(); if (view === 'saved') renderSaved(); } catch {}
        }
        toast(error.message); return false;
      }
    }
    try { localStorage.setItem(storageKey, JSON.stringify(next)); collections = next; updateCollectionCount(); return true; }
    catch { toast('This could not be saved. Check the available browser storage.'); return false; }
  } finally { collectionSaving = false; updateSaveButtons(); }
}
function updateCollectionCount() {
  const count = collections.length, label = `${count} collection${count === 1 ? '' : 's'}`;
  const badge = $('#collection-count');
  badge.textContent = String(count); badge.title = label; badge.setAttribute('aria-label', label);
  badge.hidden = !collectionsReady;
  updateSaveButtons();
}
async function quickSave(item, collectionId = '') {
  if (collectionSaving || !collectionsReady) return;
  const value = savedItem(item), key = itemKey(value);
  const contains = c => c.items.some(i => itemKey(i) === key);
  const existing = collections.find(c => c.id === collectionId && contains(c)) || collections.find(contains);
  if (existing) { openSave(value, existing.id); return; }
  const next = structuredClone(collections);
  let destination = next.find(c => c.id === 'watch-later');
  if (!destination) {
    if (next.length >= 100) { openSave(value); return; }
    destination = {id: 'watch-later', name: 'Watch later', items: []}; next.unshift(destination);
  }
  if (destination.items.length >= 200) { openSave(value); return; }
  destination.items.push(value);
  if (!await persist(next)) return;
  if (view === 'saved') renderSaved();
  toast(`Saved to ${destination.name}.`, [{label: 'Change collection', run: () => openSave(value, destination.id)}]);
}
function refreshCollectionOptions() {
  const selected = $('#collection-select').value || moveFromCollection || currentCollection;
  $('#collection-select').replaceChildren(...collections.map(c => { const o = el('option', '', c.name); o.value = c.id; return o; }));
  if (collections.some(c => c.id === selected)) $('#collection-select').value = selected;
}
function openSave(item = null, fromCollection = '') {
  if (!collectionsReady) { toast('Your collections could not load. Refresh this page before saving.'); return; }
  pendingSave = item ? savedItem(item) : null; moveFromCollection = fromCollection;
  $('#save-heading').textContent = item ? (fromCollection ? 'Change collection' : 'Save to collection') : 'New collection';
  $('#save-description').textContent = item ? (item.clip_title || item.guest || item.title) : 'Give this collection a name.';
  $('#collection-destination').hidden = !item;
  $('#collection-select').replaceChildren(); refreshCollectionOptions();
  $('#collection-select').disabled = !item;
  $('#collection-name-label').textContent = item ? 'Or create a new collection' : 'Collection name';
  $('#collection-name').value = ''; $('#collection-name').required = !item || !collections.length;
  $('#save-error').textContent = '';
  $('#confirm-save').textContent = item ? (fromCollection ? 'Move here' : 'Save here') : 'Create collection';
  const invoker = document.activeElement;
  const bookmark = pendingSave && [...document.querySelectorAll('[data-save-key]')]
    .find(node => node.dataset.saveKey === itemKey(pendingSave) && node.getClientRects().length);
  dialogReturnFocus.set($('#save-dialog'), invoker.closest('#toast') ? bookmark || $('#new-collection') : invoker);
  $('#save-dialog').showModal();
  syncCollections();
  if (!item) $('#collection-name').focus();
}
$('#save-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (collectionSaving) return;
  const name = $('#collection-name').value.trim();
  const next = structuredClone(collections);
  let collection = name ? next.find(c => c.name.toLowerCase() === name.toLowerCase()) : next.find(c => c.id === $('#collection-select').value);
  if (name && collection && !pendingSave) { $('#save-error').textContent = 'A collection with this name already exists.'; return; }
  if (name && !collection) {
    if (next.length >= 100) { $('#save-error').textContent = 'You can keep up to 100 collections.'; return; }
    collection = {id: crypto.randomUUID(), name, items: []}; next.push(collection);
  }
  if (!collection || (!pendingSave && !name)) { $('#save-error').textContent = 'Give your collection a name.'; return; }
  if (pendingSave) {
    const key = itemKey(pendingSave), alreadySaved = collection.items.some(i => itemKey(i) === key);
    if (!alreadySaved && collection.items.length >= 200) { $('#save-error').textContent = 'This collection is full. Choose another collection.'; return; }
    if (!alreadySaved) collection.items.push(pendingSave);
    if (moveFromCollection && moveFromCollection !== collection.id) {
      const previous = next.find(c => c.id === moveFromCollection);
      if (previous) previous.items = previous.items.filter(i => itemKey(i) !== key);
    }
  }
  $('#confirm-save').disabled = true;
  let saved;
  try { saved = await persist(next); } finally { $('#confirm-save').disabled = false; }
  if (!saved) return;
  currentCollection = collection.id; rememberCollection(); closeDialog('save-dialog');
  toast(pendingSave ? `Saved to ${collection.name}.` : `Created ${collection.name}.`);
  if (view === 'saved') renderSaved();
});
async function removeSaved(collectionId, key) {
  const collection = collections.find(c => c.id === collectionId), item = collection?.items.find(i => itemKey(i) === key);
  if (!item) return;
  const position = collection.items.indexOf(item);
  const next = collections.map(c => c.id === collectionId ? {...c, items: c.items.filter(i => itemKey(i) !== key)} : c);
  if (!await persist(next)) return;
  renderSaved();
  toast(`Removed from ${collection.name}.`, [{label: 'Undo', run: async () => {
    const next = structuredClone(collections), target = next.find(c => c.id === collectionId);
    if (!target) { toast('That collection no longer exists. Choose where to restore this item.'); openSave(item); return; }
    if (!target.items.some(i => itemKey(i) === key)) {
      if (target.items.length >= 200) { toast('This collection is full. Choose another collection.'); openSave(item); return; }
      target.items.splice(Math.min(position, target.items.length), 0, item);
      if (!await persist(next)) return;
    }
    renderSaved(); toast('Restored to ' + target.name + '.');
  }}]);
}
function rememberCollection() {
  try { sessionStorage.setItem('figuring-out.selected-collection.' + (account?.id || 'local'), currentCollection); } catch {}
}
function collectionItemCount(collection) {
  const clips = collection.items.filter(item => item.kind === 'moment').length, episodes = collection.items.length - clips;
  return [clips ? `${clips} clip${clips === 1 ? '' : 's'}` : '', episodes ? `${episodes} episode${episodes === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ') || '0 items';
}
function openCollectionEdit(mode) {
  const collection = collections.find(c => c.id === currentCollection); if (!collection || collectionSaving) return;
  editingCollection = {id: collection.id, mode};
  const deleting = mode === 'delete';
  $('#collection-dialog-heading').textContent = deleting ? 'Delete collection?' : 'Rename collection';
  $('#collection-dialog-description').textContent = deleting
    ? `Delete “${collection.name}” and its ${collection.items.length} saved item${collection.items.length === 1 ? '' : 's'} from this collection? Items in other collections stay.` : '';
  $('#rename-field').hidden = deleting; $('#rename-name').required = !deleting; $('#rename-name').value = collection.name;
  $('#confirm-collection-edit').textContent = deleting ? 'Delete collection' : 'Save name';
  $('#confirm-collection-edit').classList.toggle('danger-button', deleting);
  $('#collection-edit-error').textContent = '';
  lastFocused = document.activeElement; $('#collection-dialog').showModal();
  if (!deleting) { $('#rename-name').focus(); $('#rename-name').select(); }
}
async function editCollection(event) {
  event.preventDefault(); if (!editingCollection || collectionSaving) return;
  const {id, mode} = editingCollection, previous = collections.find(c => c.id === id);
  if (!previous) { closeDialog('collection-dialog'); toast('This collection no longer exists.'); return; }
  const name = $('#rename-name').value.trim();
  if (mode === 'rename' && (!name || collections.some(c => c.id !== id && c.name.toLowerCase() === name.toLowerCase()))) {
    $('#collection-edit-error').textContent = name ? 'A collection with this name already exists.' : 'Enter a collection name.'; return;
  }
  const position = collections.findIndex(c => c.id === id), snapshot = structuredClone(previous);
  const next = mode === 'delete' ? collections.filter(c => c.id !== id) : collections.map(c => c.id === id ? {...c, name} : c);
  $('#confirm-collection-edit').disabled = true;
  let saved; try { saved = await persist(next); } finally { $('#confirm-collection-edit').disabled = false; }
  if (!saved) return;
  closeDialog('collection-dialog'); renderSaved();
  if (mode === 'rename') { toast('Collection renamed.'); return; }
  toast(`Deleted ${snapshot.name}.`, [{label: 'Undo', run: async () => {
    if (collections.some(c => c.id === id)) { toast('This collection has already been restored.'); return; }
    if (collections.length >= 100) { toast('There is no room to restore this collection. Export a backup or remove an unused collection first.'); return; }
    const next = [...collections]; next.splice(Math.min(position, next.length), 0, snapshot);
    if (!await persist(next)) return;
    currentCollection = id; renderSaved(); toast('Collection restored.');
  }}]);
}
function exportCollections() {
  if (!collectionsReady) { toast('Load your collections before exporting.'); return; }
  const document = {format: 'figuring-out-collections', version: 1, exported_at: new Date().toISOString(), collections};
  const blob = new Blob([JSON.stringify(document, null, 2)], {type: 'application/json'});
  const url = URL.createObjectURL(blob), link = el('a');
  link.href = url; link.download = `figuring-out-collections-${new Date().toISOString().slice(0, 10)}.json`;
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Collections exported. Use Import collections to restore this backup.');
}
function readCollectionBackup(value) {
  if (!value || value.format !== 'figuring-out-collections' || value.version !== 1 || !Array.isArray(value.collections) || value.collections.length > 100) throw new Error('Choose a Figuring Out collection backup.');
  const ids = new Set();
  return value.collections.map(c => {
    if (!c || typeof c.id !== 'string' || !c.id.length || c.id.length > 80 || ids.has(c.id) || typeof c.name !== 'string' || !c.name.trim() || c.name.length > 60 || !Array.isArray(c.items) || c.items.length > 200) throw new Error('This backup contains an invalid collection.');
    ids.add(c.id);
    const items = c.items.map(item => {
      if (!item || !validID(item.id) || typeof item.title !== 'string' || item.title.length > 700 || !['episode', 'moment'].includes(item.kind)) throw new Error('This backup contains an invalid saved item.');
      if (item.kind === 'moment' && (!Number.isFinite(item.start) || !Number.isFinite(item.end) || item.start < 0 || item.end <= item.start || item.end > 604800 || typeof item.quote !== 'string' || item.quote.length > 30000)) throw new Error('This backup contains an invalid clip timestamp.');
      for (const [key, max] of [['clip_title', 80], ['summary', 400]]) {
        if (key in item && (typeof item[key] !== 'string' || item[key].length > max)) throw new Error('This backup contains an invalid clip description.');
      }
      return savedItem(item.kind === 'episode'
        ? {id: item.id, title: item.title, kind: 'episode', clip_title: item.clip_title, summary: item.summary}
        : item);
    });
    return {id: c.id, name: c.name.trim(), items};
  });
}
async function prepareImport(event) {
  const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
  try {
    if (file.size > 2_000_000) throw new Error('Choose a backup smaller than 2 MB.');
    pendingImport = readCollectionBackup(JSON.parse(await file.text()));
    $('#import-description').textContent = `${pendingImport.length} collections with ${pendingImport.reduce((n, c) => n + c.items.length, 0)} saved items. Add these to your library?`;
    $('#import-error').textContent = ''; lastFocused = $('#import-collections'); $('#import-dialog').showModal();
  } catch (error) { pendingImport = null; toast(error instanceof SyntaxError ? 'This file is not a readable collection backup.' : error.message); }
}
async function importCollections() {
  if (!pendingImport || collectionSaving) return;
  try {
    const next = structuredClone(collections);
    for (const incoming of pendingImport) {
      let target = next.find(c => c.id === incoming.id || c.name.toLowerCase() === incoming.name.toLowerCase());
      if (!target) { target = {...incoming, items: []}; next.push(target); }
      const keys = new Set(target.items.map(itemKey));
      for (const item of incoming.items) if (!keys.has(itemKey(item))) { target.items.push(item); keys.add(itemKey(item)); }
    }
    if (next.length > 100 || next.some(c => c.items.length > 200) || new Blob([JSON.stringify(next)]).size > 2_000_000) throw new Error('This backup would exceed the limit of 100 collections, 200 items per collection, or 2 MB of saved content.');
    $('#confirm-import').disabled = true;
    if (!await persist(next)) return;
    closeDialog('import-dialog'); renderSaved(); toast('Collections imported.');
  } catch (error) { $('#import-error').textContent = error.message; }
  finally { $('#confirm-import').disabled = false; }
}
function restoreDialogFocus(dialog) {
  const target = dialogReturnFocus.get(dialog);
  if (target?.isConnected && target.getClientRects().length &&
      (document.activeElement === document.body || document.activeElement.matches('.skip-link'))) {
    target.focus({preventScroll: true});
  }
}
function closeDialog(id) { const dialog = $('#' + id); dialog.close(); restoreDialogFocus(dialog); }
function closeActionMenu(menu, restoreFocus = false) {
  if (!menu?.open) return;
  const focused = menu.contains(document.activeElement);
  menu.open = false;
  if (restoreFocus && focused) menu.querySelector('summary').focus({preventScroll: true});
}

function navigate(next, options = {}) {
  document.querySelectorAll('.action-menu[open]').forEach(menu => closeActionMenu(menu));
  if (!['discover', 'conversations', 'saved', 'answer'].includes(next)) next = 'discover';
  if (view !== next) { stopVideo(); if ($('#video-dialog').open) $('#video-dialog').close(); }
  view = next; navigationVersion++;
  document.querySelectorAll('.view').forEach(section => { section.hidden = section.id !== `${view}-view`; });
  document.querySelectorAll('[data-view]').forEach(node => {
    if (node.closest('.main-nav') && node.dataset.view === view) node.setAttribute('aria-current', 'page');
    else node.removeAttribute('aria-current');
  });
  if (options.libraryTab) savedTab = options.libraryTab;
  const route = options.route || (view === 'answer' ? answerRoute : view === 'saved' && savedTab === 'history' ? 'saved/history' : view);
  if (options.history !== false && location.hash !== '#' + route) history[options.replace ? 'replaceState' : 'pushState'](null, '', '#' + route);
  const destination = view === 'answer' ? $('#answer-composer-body') : $('#home-composer');
  destination.append($('#question-form'), $('#availability-note'));
  $('#question').placeholder = view === 'answer' ? 'What else are you trying to figure out?' : 'Ask a question…';
  $('#question-label').textContent = view === 'answer' ? 'Ask another question' : 'Ask a question';
  if (view === 'conversations') renderCatalog();
  if (view === 'saved') { renderSaved(); syncCollections(); setLibraryTab(savedTab, false); }
  updateResume();
  updateConnection();
  if (options.scroll !== false) window.scrollTo({top: 0, behavior: 'instant'});
}
function openCatalog(search = '', selectedTopic = '') {
  query = search; topic = selectedTopic; visibleCount = 12;
  $('#catalog-search').value = search; navigate('conversations');
}
function stopVideo() {
  if (playerSession) {
    clearInterval(playerSession.timer);
    playerSession.closed = true;
    try { playerSession.api?.destroy(); } catch {}
    playerSession = null;
  }
  $('#video-container').replaceChildren(); $('#watch-container').replaceChildren();
  $('#watch-panel').hidden = true; $('#player-home').append($('#watch-panel'));
}
function loadYouTubeAPI() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (youtubeReady) return youtubeReady;
  youtubeReady = new Promise((resolve, reject) => {
    const script = el('script'); script.src = 'https://www.youtube.com/iframe_api'; script.async = true;
    let settled = false;
    const fail = () => { if (settled) return; settled = true; clearTimeout(timer); script.remove(); youtubeReady = null; reject(new Error('Player controls unavailable')); };
    const timer = setTimeout(fail, 12000);
    window.onYouTubeIframeAPIReady = () => { if (settled) return; settled = true; clearTimeout(timer); resolve(window.YT); };
    script.onerror = fail; document.head.append(script);
  });
  return youtubeReady;
}
function mediaFrame(item) {
  const id = videoID(item); if (!validID(id)) return null;
  const params = new URLSearchParams({autoplay: '1', rel: '0'});
  if (Number.isFinite(item.start)) params.set('start', String(Math.floor(Math.max(0, item.start))));
  if (Number.isFinite(item.end) && item.end > (item.start || 0)) params.set('end', String(Math.ceil(item.end)));
  params.set('playsinline', '1'); params.set('enablejsapi', '1'); params.set('origin', location.origin);
  const frame = el('iframe'); frame.id = 'active-youtube-player';
  frame.referrerPolicy = 'strict-origin-when-cross-origin';
  frame.src = `https://www.youtube-nocookie.com/embed/${id}?${params}`;
  frame.title = item.clip_title || item.title || 'Figuring Out conversation';
  frame.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen'; frame.allowFullscreen = true;
  return frame;
}
function play(item, dock = view === 'answer') {
  const frame = mediaFrame(item); if (!frame) { toast('This video link is unavailable.'); return; }
  stopVideo(); lastFocused = document.activeElement;
  const key = clipKey(item);
  const card = key ? [...document.querySelectorAll('.moment')].find(node => node.dataset.clipKey === key) : null;
  const playButton = card?.querySelector('.clip-play');
  if (dock && card) {
    card.append($('#watch-panel')); $('#watch-container').append(frame); $('#watch-panel').hidden = false;
    watchDetails(item); $('#watch-panel').scrollIntoView({behavior: 'instant', block: 'nearest'});
  } else {
    $('#video-title').textContent = `${item.clip_title || item.title}${key ? ' · ' + clipRange(item) : ''}`;
    $('#video-external').href = fullVideoURL(item); $('#video-container').append(frame);
    $('#video-playback-status').textContent = key ? `Stops at ${timeLabel(Math.ceil(item.end))}` : 'Full video';
    if (!$('#video-dialog').open) $('#video-dialog').showModal();
  }
  const session = {frame, item, playButton, closed: false, ended: false, api: null, timer: null, inline: dock && !!card};
  playerSession = session;
  const setStatus = text => { if (!session.closed) (session.inline ? $('#clip-playback-status') : $('#video-playback-status')).textContent = text; };
  const ended = () => {
    if (session.closed || session.ended) return;
    session.ended = true; setStatus(key ? `Clip finished · ${clipRange(item)}` : 'Video finished');
    if (playButton) { playButton.replaceChildren(document.createTextNode('Replay clip'), icon('play')); playButton.setAttribute('aria-label', `Replay clip ${card.dataset.clipNumber}: ${clipRange(item)}`); }
  };
  loadYouTubeAPI().then(YT => {
    if (session.closed || !frame.isConnected) return;
    session.api = new YT.Player(frame, {events: {
      onReady: () => {
        if (session.closed || !key) return;
        session.timer = setInterval(() => {
          if (session.closed || session.ended) return;
          if (session.api.getCurrentTime() >= Math.ceil(item.end)) { session.api.pauseVideo(); ended(); }
        }, 200);
      },
      onStateChange: event => {
        if (session.closed) return;
        if (event.data === 0) ended();
        else if (event.data === 1) {
          // Seeking or the embedded replay control must not bypass the clip end.
          session.ended = false;
          setStatus(key ? `Playing · stops at ${timeLabel(Math.ceil(item.end))}` : 'Playing full video');
        } else if (event.data === 2 && !session.ended) setStatus(key ? `Paused · stops at ${timeLabel(Math.ceil(item.end))}` : 'Paused');
      },
      onError: () => setStatus('This video could not play here. Use Full video to open it on YouTube.'),
      onAutoplayBlocked: () => setStatus('Press play in the video to start the clip.'),
    }});
  }).catch(() => { /* The bounded embed still works if the optional player API cannot load. */ });
}
function watchDetails(item) {
  const status = el('p', '', `Stops at ${timeLabel(Math.ceil(item.end))}`);
  status.id = 'clip-playback-status'; status.setAttribute('role', 'status');
  $('#watch-details').replaceChildren(status);
}
function episodeArt(video) {
  const node = button('', 'episode-art', () => play(video)); node.setAttribute('aria-label', `Watch ${video.guest || video.display_title || video.title}`);
  const circle = el('span', 'play-circle'); circle.append(icon('play')); node.append(imageFor(video), circle);
  if (video.episode) node.append(el('span', 'episode-number', `EP. ${video.episode}`));
  return node;
}
function episodeCard(video, className = 'catalog-card', collectionId = '') {
  const article = el('article', className); article.append(episodeArt(video));
  const copy = el('div', 'episode-copy');
  copy.append(el('p', 'episode-meta', video.kind === 'moment' ? `Saved clip · ${clipRange(video)} · ${timeLabel(Math.ceil(video.end) - Math.floor(video.start))}` : (video.topic || 'Figuring Out')));
  const heading = el('div', 'episode-copy-heading');
  heading.append(el('h3', '', video.clip_title || video.display_title || video.title), saveButton(video, `Save ${video.guest || video.title}`, collectionId));
  copy.append(heading, el('p', 'episode-guest', video.guest ? `${video.guest}${video.role ? ' · ' + video.role : ''}` : `Figuring Out${video.episode ? ' · Episode ' + video.episode : ''}`));
  if (video.kind === 'moment' && video.summary) copy.append(el('p', 'saved-summary', video.summary));
  if (collectionId) {
    const actions = el('div', 'saved-actions');
    actions.append(button(video.kind === 'moment' ? 'Play clip' : 'Play video', 'text-link saved-play', () => play(video), 'play'),
      button('Remove from collection', 'remove-save', () => removeSaved(collectionId, itemKey(video))));
    copy.append(actions);
  }
  article.append(copy); return article;
}
function episodeRow(video) {
  const row = el('article', 'episode-row'), copy = el('div');
  copy.append(el('p', 'episode-meta', video.topic), el('h3', '', video.display_title || video.title), el('p', 'episode-guest', video.guest || 'Figuring Out'));
  row.append(episodeArt(video), copy, saveButton(video, `Save ${video.guest || video.title}`)); return row;
}
function renderHome() {
  $('#home-topics').replaceChildren(...topics.map(name => button(name, 'topic-button', () => openCatalog('', name))));
  const lead = findVideo('46P1rL0rzPE'); const list = el('div', 'editorial-list');
  ['PXMyK7JxGOk', 'sGpc8-f2e8U', '4Vz6L8B73i4'].map(findVideo).filter(Boolean).forEach(v => list.append(episodeRow(v)));
  $('#editorial-picks').replaceChildren(...(lead ? [episodeCard(lead, 'editorial-lead'), list] : [list]));
}
function matches(video) {
  if (topic && video.topic !== topic) return false;
  if (!query.trim()) return true;
  const tokens = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const stop = new Set('the a an how can i do does what is are to of on for my me and with conversations videos say about'.split(' '));
  const terms = tokens.filter(t => !stop.has(t) && t.length > 1);
  const text = [video.title, video.topic, video.guest].join(' ').toLowerCase();
  return terms.length ? terms.some(term => text.includes(term)) : text.includes(query.toLowerCase());
}
function renderCatalog() {
  $('#catalog-topics').replaceChildren(...['All conversations', ...topics].map((name, i) => {
    const node = button(name, '', () => { topic = i ? name : ''; visibleCount = 12; renderCatalog(); });
    node.setAttribute('aria-pressed', String(topic === (i ? name : ''))); return node;
  }));
  const rows = catalog.filter(matches);
  $('#catalog-count').textContent = `${rows.length} conversation${rows.length === 1 ? '' : 's'}${query ? ' matching episode titles and topics' : topic ? ' · ' + topic : ' in the catalog'}`;
  $('#clear-filters').hidden = !topic && !query;
  $('#catalog-grid').replaceChildren(...rows.slice(0, visibleCount).map(v => episodeCard(v)));
  if (!rows.length) {
    const empty = el('div', 'empty-content'); empty.append(el('h3', '', 'Try a different starting point.'), el('p', '', 'No episode titles or topics match this search. Try a guest name, a broader topic, or clear the filters.'), button('Explore all conversations', 'text-link', () => openCatalog(), 'arrow'));
    $('#catalog-grid').append(empty);
  }
  $('#load-more').hidden = rows.length <= visibleCount;
}
function setLibraryTab(tab, updateRoute = true) {
  savedTab = tab === 'history' ? 'history' : 'collections';
  document.querySelectorAll('[data-library-tab]').forEach(node => {
    const selected = node.dataset.libraryTab === savedTab;
    node.setAttribute('aria-selected', String(selected)); node.tabIndex = selected ? 0 : -1;
  });
  $('#collections-panel').hidden = savedTab !== 'collections'; $('#history-panel').hidden = savedTab !== 'history';
  $('#new-collection').hidden = savedTab !== 'collections';
  $('#backup-menu').hidden = savedTab !== 'collections';
  document.querySelectorAll('.action-menu[open]').forEach(menu => closeActionMenu(menu));
  if (updateRoute && view === 'saved') history.replaceState(null, '', '#saved' + (savedTab === 'history' ? '/history' : ''));
  if (savedTab === 'history') { historyOffset = 0; loadHistory(); }
  else historyVersion++;
}
function renderSaved() {
  closeActionMenu($('#collection-menu'));
  if (!currentCollection) { try { currentCollection = sessionStorage.getItem('figuring-out.selected-collection.' + (account?.id || 'local')) || ''; } catch {} }
  if (!collections.some(c => c.id === currentCollection)) currentCollection = collections[0]?.id || '';
  rememberCollection();
  $('#collection-tabs').replaceChildren(...collections.map(c => {
    const node = button('', 'collection-folder', () => {
      currentCollection = c.id; rememberCollection(); renderSaved();
      $('#collection-tabs [aria-pressed=true]')?.focus({preventScroll: true});
    });
    const copy = el('span', 'folder-copy'); copy.append(el('strong', '', c.name), el('span', '', collectionItemCount(c)));
    node.append(icon('folder'), copy); node.setAttribute('aria-pressed', String(c.id === currentCollection)); return node;
  }));
  const collection = collections.find(c => c.id === currentCollection);
  $('#collection-toolbar').hidden = !collection; $('#active-collection-name').textContent = collection?.name || '';
  $('#saved-grid').replaceChildren(...(collection?.items || []).map(item => episodeCard({...findVideo(item.id), ...item}, 'catalog-card', collection.id)));
  if (!collection?.items.length) {
    const empty = el('div', 'empty-content');
    empty.append(el('h3', '', !collectionsReady ? 'Collections unavailable' : collection ? 'No saved items yet' : 'Create your first collection'),
      el('p', '', !collectionsReady ? 'Reload this page to try again.' : collection?.id === 'watch-later' ? 'Bookmarked clips and episodes appear here.' : collection ? 'Move saved clips or episodes into this collection.' : 'Create a collection to organize clips and episodes.'),
      button('Browse conversations', 'solid-button', () => openCatalog(), 'arrow'));
    $('#saved-grid').append(empty);
  }
  updateSaveButtons();
}
async function loadHistory(offset = 0) {
  const version = ++historyVersion;
  $('#history-more').disabled = true;
  try {
    const result = await api('/api/responses?offset=' + offset);
    if (version !== historyVersion || view !== 'saved' || savedTab !== 'history') return;
    if (!offset) $('#response-history').replaceChildren();
    result.items.forEach(item => {
      const row = el('article', 'history-row');
      const open = button('', '', () => openHistory(item.id));
      open.append(el('h3', '', item.question || 'Question'), el('p', '', `${new Date(item.created_at).toLocaleDateString(undefined, {month: 'short', day: 'numeric', year: 'numeric'})} · ${item.status === 'error' ? 'Request could not finish' : item.status.replaceAll('_', ' ')}`));
      row.append(open); $('#response-history').append(row);
    });
    if (!result.total) {
      const empty = el('div', 'empty-content');
      empty.append(el('h3', '', 'No past questions yet'), button(busy ? 'Return to your question' : 'Ask a question', 'solid-button', () => {
        navigate(busy ? 'answer' : 'discover'); if (!busy) $('#question').focus();
      }, 'arrow'));
      $('#response-history').append(empty);
    }
    historyOffset = offset + result.items.length;
    $('#history-more').hidden = historyOffset >= result.total;
  } catch {
    if (version !== historyVersion || view !== 'saved' || savedTab !== 'history') return;
    if (offset) toast('Older questions could not load. Please try again.');
    else $('#response-history').replaceChildren(el('p', 'section-note', 'Past questions could not load. Try again shortly.'));
  } finally { if (version === historyVersion) $('#history-more').disabled = false; }
}
async function openHistory(id, options = {}) {
  if (busy) { toast('Let this question finish before opening another.'); return; }
  const version = ++navigationVersion;
  try {
    const record = await api('/api/responses/' + id);
    if (version !== navigationVersion || busy) return;
    lastQuestion = {question: record.question, sourceID: record.source_id || ''};
    answerRoute = 'answer/' + id;
    beginAnswer(record.question, {...options, route: answerRoute}); renderAnswer(record.response);
    if (!record.response.error) $('#request-status').textContent = `Saved response · ${new Date(record.created_at).toLocaleString()}`;
  } catch (error) { toast(error.message); }
}
function followRoute() {
  const route = location.hash.slice(1);
  if (route.startsWith('moment-')) return;
  if (/^answer\/[a-f0-9]{32}$/.test(route)) {
    if (route === answerRoute && $('#asked-question').textContent) navigate('answer', {history: false});
    else if (busy) { toast('Your current question is still being checked.'); navigate('answer', {replace: true}); }
    else openHistory(route.split('/')[1], {history: false});
  } else if (route === 'answer' && $('#asked-question').textContent) navigate('answer', {replace: true});
  else navigate(route === 'saved/history' ? 'saved' : ['discover', 'conversations', 'saved'].includes(route) ? route : 'discover', {replace: true, libraryTab: route === 'saved/history' ? 'history' : 'collections'});
}
function updateResume() {
  $('#resume-question').hidden = view === 'answer' || !$('#asked-question').textContent;
  $('#resume-label').textContent = busy ? 'Your question is being checked. Return to the conversation' : 'Return to your last question';
}
function setProgress(text, error = false, loading = false) {
  $('#request-status').textContent = text; $('#request-status').className = 'request-status' + (error ? ' error' : '') + (loading ? ' loading' : '');
  // While an answer is prepared, the reasoning panel shows the same stage message.
  if (loading) $('#reasoning-title .shimmer').textContent = text;
}
const phaseLabels = {search: 'Search conversations', review: 'Check source clips', compose: 'Prepare answer'};
let reasoningLog = [];
function phaseMarker(state, orb) {
  if (state === 'active') {
    const spinner = el('thinking-orb'); spinner.setAttribute('state', orb); spinner.setAttribute('size', '20');
    spinner.setAttribute('aria-hidden', 'true'); return spinner;
  }
  return state === 'complete' ? icon('check') : el('span', 'marker-ring');
}
function assistantOrb(state) {
  // The orb replaces the brand mark only while this answer is being prepared.
  const orb = $('#assistant-orb');
  orb.setAttribute('state', state || 'breathing');
  orb.toggleAttribute('paused', !state);
  orb.parentElement.classList.toggle('thinking', Boolean(state));
}
function generationPhase(phase) {
  const phases = ['search', 'review', 'compose'], current = phases.indexOf(phase);
  if (current < 0) return;
  $('#answer-step').textContent = `Step ${current + 1} of ${phases.length}`;
  document.querySelectorAll('#answer-progress [data-phase]').forEach((node, index) => {
    const active = index === current, complete = index < current, state = active ? 'active' : complete ? 'complete' : 'waiting';
    if (node.dataset.state !== state) node.querySelector('.phase-marker').replaceChildren(phaseMarker(state, node.dataset.orb));
    node.dataset.state = state;
    if (active) { node.setAttribute('aria-current', 'step'); assistantOrb(node.dataset.orb); }
    else node.removeAttribute('aria-current');
    node.querySelector('.phase-state').textContent = active ? 'In progress' : complete ? 'Done' : 'Waiting';
  });
  renderReasoningFeed();
}
function reasoningDetail(phase, message) {
  if (!phaseLabels[phase] || typeof message !== 'string' || !message.trim()) return;
  if (reasoningLog.at(-1)?.message === message) return;
  reasoningLog.push({phase, message: message.slice(0, 240)}); renderReasoningFeed();
}
function renderReasoningFeed() {
  // Like the audit timeline it comes from: only the running step shows its recent work.
  document.querySelectorAll('#answer-progress [data-phase]').forEach(node => {
    const feed = node.querySelector('.reasoning-feed');
    if (node.dataset.state !== 'active') { feed.replaceChildren(); return; }
    const recent = reasoningLog.filter(line => line.phase === node.dataset.phase).slice(-4);
    feed.replaceChildren(...recent.map((line, index) => el('p', index === recent.length - 1 ? 'latest' : '', line.message)),
      el('p', 'thinking shimmer', 'Thinking…'));
  });
}
function showReasoningSummary(answered, seconds) {
  const steps = ['search', 'review', 'compose'].filter(phase => reasoningLog.some(line => line.phase === phase));
  if (!steps.length) return;
  $('#reasoning-summary-label').textContent = `${answered ? 'How this answer was checked' : 'How the archive was searched'} · ${timeLabel(seconds)}`;
  $('#reasoning-log').replaceChildren(...steps.map(phase => {
    const step = el('li'), lines = el('ul');
    lines.append(...reasoningLog.filter(line => line.phase === phase).map(line => el('li', '', line.message)));
    step.append(el('strong', '', phaseLabels[phase]), lines); return step;
  }));
  $('#reasoning-summary').open = false; $('#reasoning-summary').hidden = false;
}
function resetReasoning() {
  reasoningLog = []; assistantOrb('');
  $('#reasoning-summary').hidden = true; $('#reasoning-log').replaceChildren();
  $('#reasoning-title .shimmer').textContent = 'Thinking…';
  document.querySelectorAll('#answer-progress [data-phase]').forEach(node => {
    delete node.dataset.state; node.removeAttribute('aria-current');
    node.querySelector('.phase-marker').replaceChildren(phaseMarker('waiting'));
    node.querySelector('.phase-state').textContent = 'Waiting';
    node.querySelector('.reasoning-feed').replaceChildren();
  });
}
function beginAnswer(question, options = {}) {
  stopVideo(); navigate('answer', options); $('#asked-question').textContent = question; $('#answer').replaceChildren(); $('#moments').replaceChildren(); $('#moments-section').hidden = true;
  $('#answer-label').hidden = true;
  $('#retry-question').hidden = true;
  $('#answer-scope').textContent = lastQuestion?.sourceID ? 'Conversation: ' + (findVideo(lastQuestion.sourceID)?.title || 'Selected conversation') : 'All conversations';
  $('#watch-panel').hidden = true; $('#watch-container').replaceChildren(); setProgress(''); resetReasoning();
}
const matchLabels = {direct: 'Direct match', related: 'Related context', closest: 'Closest match'};
function momentCard(citation, index, guide) {
  const node = el('article', 'moment'); node.id = `moment-${index + 1}`; node.tabIndex = -1;
  node.dataset.clipKey = clipKey(citation); node.dataset.clipNumber = String(index + 1);
  const title = guide?.clip_title || citation.clip_title || `Clip ${index + 1}: ${findVideo(videoID(citation))?.guest || 'Figuring Out'}`;
  const item = {...citation, kind: 'moment', clip_title: guide?.clip_title || citation.clip_title || '', summary: guide?.summary || citation.summary || ''};
  // The thumbnail repeats the labelled Play clip button for pointer users only.
  const thumb = el('div', 'moment-thumb'); thumb.setAttribute('aria-hidden', 'true');
  const glyph = el('span', 'play-circle'); glyph.append(icon('play'));
  thumb.append(imageFor(citation), glyph, el('span', 'moment-duration', timeLabel(Math.ceil(citation.end) - Math.floor(citation.start))));
  thumb.addEventListener('click', () => play(item, true));
  const body = el('div', 'moment-body'), top = el('div', 'moment-topline'), copy = el('div');
  // The number matches the answer's citation chips.
  const heading = el('div', 'clip-heading'), number = el('span', 'clip-number', String(index + 1));
  number.setAttribute('aria-hidden', 'true'); heading.append(number, el('h3', '', title));
  const meta = el('p', 'clip-time', [findVideo(videoID(citation))?.guest, clipRange(citation)].filter(Boolean).join(' · '));
  if (matchLabels[guide?.match]) meta.append(el('span', `moment-match ${guide.match}`, matchLabels[guide.match]));
  const source = el('p', 'clip-source', citation.title || findVideo(videoID(citation))?.title); source.title = source.textContent;
  copy.append(heading, meta, source);
  top.append(copy, saveButton(item, 'Save this clip')); body.append(top);
  const description = guide?.summary || guide?.why_relevant;
  if (description) body.append(el('p', 'moment-copy', description));
  if (guide?.limitation) body.append(el('p', 'moment-limit', guide.limitation));
  const actions = el('div', 'moment-actions');
  const playButton = button('Play clip', 'clip-play solid-button', () => play(item, true), 'play');
  playButton.setAttribute('aria-label', `Play clip ${index + 1}: ${clipRange(citation)}`);
  actions.append(playButton, external('Full video', fullVideoURL(citation))); body.append(actions);
  node.append(thumb, body); return node;
}
function renderMoments(items) {
  stopVideo(); $('#moments-section').hidden = !items.length;
  $('#moments-heading').textContent = 'Source clips';
  $('#moment-count').textContent = `${items.length} clip${items.length === 1 ? '' : 's'}`;
  $('#moments').replaceChildren(...items.map((item, i) => momentCard(item.citation || item, i, item)));
}
function renderAnswer(answer) {
  $('#answer').replaceChildren();
  $('#answer-label').hidden = true;
  $('#retry-question').hidden = true;
  if (/^[a-f0-9]{32}$/.test(answer.record_id || '')) {
    answerRoute = 'answer/' + answer.record_id;
    if (view === 'answer') history.replaceState(null, '', '#' + answerRoute);
  }
  if (answer.error) {
    renderMoments([]);
    $('#retry-question').hidden = false;
    $('#answer').append(el('p', 'answer-message error', answer.error));
    setProgress('The request could not finish.', true); return;
  }
  const noEvidence = ['insufficient_evidence', 'invalid_evidence', 'needs_clarification'].includes(answer.status);
  const structured = Array.isArray(answer.answer_parts) && answer.answer_parts.length > 0;
  const points = noEvidence ? [] : structured ? answer.answer_parts : answer.points || [];
  const moments = [], seen = new Set();
  const addMoment = item => {
    const citation = item?.citation || item, key = clipKey(citation);
    if (key && !seen.has(key)) { seen.add(key); moments.push({...item, citation}); }
  };
  if (!noEvidence) (answer.recommendations || []).forEach(addMoment);
  points.forEach(p => (p.citations || []).forEach(c => addMoment({citation: c, summary: c.summary})));
  if (points.length) {
    $('#answer-label').hidden = false;
    const prose = el('div', 'answer-prose');
    const details = el('ul', 'answer-points');
    points.forEach((point, index) => {
      const paragraph = el('p', index === 0 ? 'answer-lead' : '', point.text), linked = new Set();
      (point.citations || []).forEach(c => {
        const number = moments.findIndex(m => clipKey(m.citation) === clipKey(c)) + 1;
        if (number < 1 || linked.has(number)) return;
        const link = button(String(number), 'citation-link', () => play(c, true));
        link.setAttribute('aria-label', `Play clip ${number}: ${clipRange(c)}`);
        paragraph.append(link); linked.add(number);
      });
      if (index === 0) prose.append(paragraph);
      else { const row = el('li'); row.append(paragraph); details.append(row); }
    });
    if (details.children.length) prose.append(details);
    if (structured && answer.answer_limitation) prose.append(el('p', 'answer-limitation', answer.answer_limitation));
    $('#answer').append(prose);
  } else {
    $('#answer').append(el('p', 'answer-message', answer.message || 'There isn’t enough verified evidence for an answer. Try a more specific question.'));
    $('#retry-question').hidden = !(['provider_error', 'invalid_evidence'].includes(answer.reply_status) || answer.status === 'invalid_evidence');
  }
  renderMoments(moments);
  setProgress(answer.recording_error || (answer.record_id ? 'Saved to your past questions.' : ''), Boolean(answer.recording_error));
}
async function ask(question, selectedTopic = '', options = {}) {
  if (busy || !question.trim()) return;
  question = question.trim();
  if (question.length > 6000) { toast('Keep your question under 6,000 characters.'); return; }
  if (!canAnswer()) {
    if (view === 'answer') { toast('The answer archive is unavailable. Your draft is kept here; reconnect the library to ask it.'); return; }
    openCatalog(selectedTopic ? '' : question, selectedTopic);
    toast('Showing episode titles and topics. Answer search needs the connected caption archive.'); return;
  }
  const sourceID = options.sourceID ?? '';
  lastQuestion = {question, sourceID}; answerRoute = 'answer';
  busy = true; $('#ask-button').disabled = true;
  if (!options.retry) { $('#question').value = ''; $('#question').style.height = '44px'; }
  beginAnswer(question); setProgress('Searching the original conversations…', false, true);
  updateConnection(); $('#asked-question').focus({preventScroll: true});
  generationPhase('search'); $('#answer-progress').hidden = false;
  let answered = false;
  const startedAt = Date.now();
  const elapsed = () => { $('#answer-elapsed').textContent = `Elapsed ${timeLabel((Date.now() - startedAt) / 1000)}`; };
  elapsed(); const elapsedTimer = setInterval(elapsed, 1000);
  const controller = new AbortController();
  const request = {controller, cancelled: false}; activeRequest = request;
  let reader, timedOut = false;
  const slowTimer = setTimeout(() => setProgress('This is taking longer than usual. Still preparing your answer…', false, true), 30000);
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 300000);
  $('#answer').setAttribute('aria-busy', 'true');
  try {
    const payload = {question}; if (sourceID) payload.source_id = sourceID;
    const response = await fetch('/api/ask/stream', {method: 'POST', headers: accountHeaders({'Content-Type': 'application/json'}), body: JSON.stringify(payload), signal: controller.signal});
    if (!response.ok) { const data = await response.json(); checkSessionResponse(response, data); throw new Error(data.error || 'This question could not be sent.'); }
    if (!response.body) throw new Error('The response stream is unavailable in this browser.');
    reader = response.body.getReader();
    const decoder = new TextDecoder(); let buffer = '', finished = false;
    const consume = line => {
      if (finished || request.cancelled || !line.trim()) return;
      const event = JSON.parse(line);
      if (event.type === 'stage' && typeof event.message === 'string') {
        setProgress(event.message, false, true); generationPhase(event.phase);
      }
      if (event.type === 'detail') reasoningDetail(event.phase, event.message);
      // Older servers may send raw excerpts. Only the final response can show clips.
      if (event.type === 'answer') { renderAnswer(event.response); finished = true; answered = !event.response.error; }
    };
    while (!finished) {
      const part = await reader.read(); buffer += decoder.decode(part.value || new Uint8Array(), {stream: !part.done});
      let newline;
      while (!finished && (newline = buffer.indexOf('\n')) >= 0) { consume(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
      if (part.done) { consume(buffer); break; }
    }
    if (!finished) throw new Error('The connection ended before your answer was ready. Please retry your question.');
  } catch (error) {
    $('#answer').replaceChildren(); renderMoments([]);
    $('#retry-question').hidden = request.cancelled;
    if (request.cancelled) { $('#question').value = question; $('#question').dispatchEvent(new Event('input')); }
    const message = request.cancelled ? 'Stopped waiting. Your question is ready to edit or send again. A completed answer may still appear in Past questions.' : timedOut ? 'Your answer is taking too long. Check your past questions shortly, or retry.'
      : error instanceof SyntaxError ? 'The response could not be read. Please retry your question.'
      : error instanceof TypeError ? 'The connection was interrupted. Please retry your question.'
      : error.message || 'This request could not finish. Please try again.';
    setProgress(message, !request.cancelled);
    // The reply shows the outcome; the status line keeps announcing it once.
    const reply = el('p', 'answer-message' + (request.cancelled ? '' : ' error'), message);
    reply.setAttribute('aria-hidden', 'true'); $('#answer').append(reply);
    $('#request-status').classList.add('mirrored');
  } finally {
    clearTimeout(slowTimer); clearTimeout(timeout); clearInterval(elapsedTimer);
    $('#answer-progress').hidden = true; assistantOrb('');
    if (answered) showReasoningSummary(Boolean($('#answer .answer-prose')), (Date.now() - startedAt) / 1000);
    if (reader) reader.cancel().catch(() => {});
    controller.abort();
    $('#answer').setAttribute('aria-busy', 'false');
    if (activeRequest === request) activeRequest = null;
    busy = false; $('#ask-button').disabled = false; updateConnection(); updateResume();
    if (view === 'saved' && savedTab === 'history') { historyOffset = 0; loadHistory(); }
  }
}
function cancelQuestion() {
  if (!activeRequest || !busy) return;
  activeRequest.cancelled = true; activeRequest.controller.abort();
}
function updateConnection() {
  $('#answer-composer').hidden = busy;
  $('#cancel-question').disabled = !busy;
  $('#question-form').hidden = busy;
  $('#availability-note').hidden = busy;
  $('#ask-button').setAttribute('aria-label', view === 'answer' ? 'Ask another question' : canAnswer() ? 'Ask the archive' : 'Browse matching episodes');
  $('#availability-note').textContent = canAnswer() ? '' : 'Browse episodes. Answer search is currently unavailable.';
  if (view === 'answer') $('#availability-note').textContent = 'Each question searches independently. Include the names or topics you mean.';
  if (view === 'answer' && !busy && !canAnswer()) $('#availability-note').textContent = 'The answer archive is unavailable. Your draft stays here while the library reconnects.';
  $('#retry-question').disabled = busy;
}
async function refreshStatus() {
  const version = ++statusVersion;
  try {
    const next = await api('/api/status');
    if (next.read_only && next.counts?.ready > next.sources.length) {
      const sources = [...next.sources], seen = new Set(sources.map(v => v.id));
      while (sources.length < next.counts.ready) {
        const page = await api('/api/videos?offset=' + sources.length + '&status=ready');
        const extra = page.sources.filter(v => !seen.has(v.id));
        if (!extra.length) break;
        extra.forEach(v => { seen.add(v.id); sources.push(v); });
        if (version !== statusVersion) return;
      }
      next.sources = sources;
    }
    if (version !== statusVersion) return;
    status = next;
  } catch { if (version !== statusVersion) return; status = null; }
  updateConnection();
}
function bind() {
  document.querySelectorAll('[data-view]').forEach(node => node.addEventListener('click', () => navigate(node.dataset.view)));
  document.querySelectorAll('[data-close]').forEach(node => node.addEventListener('click', () => closeDialog(node.dataset.close)));
  $('#question-form').addEventListener('submit', event => { event.preventDefault(); ask($('#question').value); });
  $('#question').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('#question-form').requestSubmit(); } });
  $('#question').addEventListener('input', () => { $('#question').style.height = '44px'; $('#question').style.height = Math.min($('#question').scrollHeight, 130) + 'px'; });
  $('#catalog-search-form').addEventListener('submit', event => { event.preventDefault(); query = $('#catalog-search').value; visibleCount = 12; renderCatalog(); });
  $('#catalog-search').addEventListener('input', () => { query = $('#catalog-search').value; visibleCount = 12; renderCatalog(); });
  $('#clear-filters').addEventListener('click', () => openCatalog());
  $('#load-more').addEventListener('click', () => { visibleCount += 12; renderCatalog(); });
  document.querySelectorAll('[data-history]').forEach(node => node.addEventListener('click', () => navigate('saved', {libraryTab: 'history'})));
  document.querySelectorAll('[data-library-tab]').forEach(node => {
    node.addEventListener('click', () => setLibraryTab(node.dataset.libraryTab));
    node.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 'collections' : event.key === 'End' ? 'history' : savedTab === 'history' ? 'collections' : 'history';
      setLibraryTab(next); $('#' + (next === 'history' ? 'history' : 'collections') + '-tab').focus();
    });
  });
  document.querySelectorAll('.action-menu button').forEach(node => node.addEventListener('click', () => closeActionMenu(node.closest('.action-menu'), true)));
  document.addEventListener('click', event => document.querySelectorAll('.action-menu[open]').forEach(menu => {
    if (!menu.contains(event.target)) closeActionMenu(menu);
  }));
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const menus = [...document.querySelectorAll('.action-menu[open]')];
    if (menus.length) { event.preventDefault(); menus.forEach(menu => closeActionMenu(menu, true)); }
  });
  $('#rename-collection').addEventListener('click', () => openCollectionEdit('rename'));
  $('#delete-collection').addEventListener('click', () => openCollectionEdit('delete'));
  $('#collection-edit-form').addEventListener('submit', editCollection);
  $('#export-collections').addEventListener('click', exportCollections);
  $('#import-collections').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', prepareImport);
  $('#confirm-import').addEventListener('click', importCollections);
  $('#new-collection').addEventListener('click', () => openSave());
  $('#history-more').addEventListener('click', () => loadHistory(historyOffset));
  $('#cancel-question').addEventListener('click', cancelQuestion);
  $('#retry-question').addEventListener('click', () => { if (lastQuestion) ask(lastQuestion.question, '', {sourceID: lastQuestion.sourceID, retry: true}); });
  $('#return-to-answer').addEventListener('click', () => navigate('answer'));
  $('#close-watch').addEventListener('click', () => { stopVideo(); lastFocused?.focus({preventScroll: true}); });
  $('#close-video').addEventListener('click', () => closeDialog('video-dialog'));
  $('#video-external').addEventListener('click', () => { stopVideo(); closeDialog('video-dialog'); });
  $('#video-dialog').addEventListener('close', () => {
    if (playerSession && !playerSession.inline) stopVideo();
    if (document.activeElement === document.body && lastFocused?.isConnected) lastFocused.focus();
  });
  // Native dialogs restore focus when closing. A later close-event handler must
  // not take focus back after the user has already moved to another control.
  $('#save-dialog').addEventListener('close', event => restoreDialogFocus(event.target));
  window.addEventListener('hashchange', followRoute);
  window.addEventListener('storage', event => { if (!accountRequired && (event.key === storageKey || event.key === null)) { collections = loadCollections(); updateCollectionCount(); if (view === 'saved') renderSaved(); if ($('#save-dialog').open) refreshCollectionOptions(); } });
  collectionChannel?.addEventListener('message', event => {
    if (!guestMode && account && (event.data?.type === 'signed-out' && event.data.owner === account.id ||
        event.data?.type === 'account-changed' && event.data.owner !== account.id)) { leaveAccount(); return; }
    if (event.data?.owner === account?.id) syncCollections(true);
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkCurrentAccount(); });
  $('#account-button').addEventListener('click', async () => {
    $('#account-button').disabled = true;
    try {
      const result = await api('/auth/logout', {method: 'POST'});
      collectionChannel?.postMessage({type: 'signed-out', owner: account.id});
      leaveAccount(result.redirect);
    } catch (error) { $('#account-button').disabled = false; toast(error.message); }
  });
  window.addEventListener('pageshow', event => { if (accountRequired && event.persisted) { document.body.hidden = true; location.reload(); } });
  window.addEventListener('focus', checkCurrentAccount);
}
async function refreshCollections() {
  if (collectionSaving) return;
  const version = ++collectionLoadVersion;
  const result = await api('/api/collections');
  // A delayed read must never replace a newer save or another refresh.
  if (version !== collectionLoadVersion || collectionSaving || result.revision < collectionRevision) return;
  const changed = !collectionsReady || result.revision !== collectionRevision;
  collections = result.items; collectionRevision = result.revision; collectionsReady = true; updateCollectionCount();
  if (changed && view === 'saved') renderSaved();
  if (changed && $('#save-dialog').open) refreshCollectionOptions();
}
function syncCollections(quiet = false) {
  if (!accountRequired || !account || collectionSaving) return;
  return refreshCollections().catch(() => { if (!quiet) toast('Collections could not refresh. Try again shortly.'); });
}
async function init() {
  bind();
  if (accountRequired) {
    try {
      account = await api('/api/account');
      if (!guestMode) collectionChannel?.postMessage({type: 'account-changed', owner: account.id});
      $('#account-button').hidden = guestMode; $('#account-button').title = guestMode ? '' : 'Signed in as ' + account.email;
      $('#collection-storage-note').textContent = guestMode
        ? 'Saved for this browser for up to 30 days.'
        : 'Saved conversations and past questions, available across your devices.';
      $('#history-storage-note').textContent = guestMode ? 'Saved for this browser' : 'Visible only to your account';
      $('#save-dialog .dialog-note').textContent = guestMode ? 'Saved for this browser. No account needed.' : 'Saved to your account.';
      await refreshCollections().catch(() => toast('Your collections could not load. Reload this page before saving.'));
    } catch (error) {
      if (error.status === 401 && !guestMode) { leaveAccount(); return; }
      toast(guestMode ? 'Your browser session could not load. Allow cookies and refresh before asking or saving.'
        : 'Your account could not load. Refresh before asking or saving.'); return;
    }
  } else { collections = loadCollections(); updateCollectionCount(); }
  try {
    const data = await api('/catalog.json'); catalog = data.episodes.filter(v => validID(v.id));
    renderHome();
  } catch { $('#editorial-picks').replaceChildren(el('p', 'section-note', 'The episode catalog could not load. Refresh to try again.')); }
  await refreshStatus();
  followRoute();
  statusTimer = setInterval(() => {
    if (!document.hidden) { if (!busy) refreshStatus(); syncCollections(true); }
  }, 15000);
}
init();

const form = document.querySelector('#save-form');
const list = document.querySelector('#bookmark-list');
const count = document.querySelector('#count');
const status = document.querySelector('#status');
const dataLocation = document.querySelector('#data-location');
const view = document.querySelector('#view');
const filterForm = document.querySelector('#filter-form');
const search = document.querySelector('#search');
const sort = document.querySelector('#sort');
const selectedTags = new Set();
let tagLabels = [];
const editor = document.querySelector('#editor');
const editForm = document.querySelector('#edit-form');
const editStatus = document.querySelector('#edit-status');
const tagInput = document.querySelector('#tag-input');
let editingId;
let editingIdentity;
let editorVersion = 0;
let editingTags = [];
let bookmarks = [];
let loadVersion = 0;

function setStatus(message, isError = false) {
  status.textContent = message;
  status.classList.toggle('error', isError);
  status.setAttribute('aria-live', isError ? 'assertive' : 'polite');
}

function render(filtered) {
  list.replaceChildren();
  count.textContent = `${bookmarks.length} ${bookmarks.length === 1 ? 'bookmark' : 'bookmarks'}`;
  if (!bookmarks.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = filtered ? 'No bookmarks match these filters. Clear filters to start again.' : 'No bookmarks yet.';
    list.append(empty);
    return;
  }
  for (const bookmark of bookmarks) {
    const article = document.createElement('article');
    article.className = 'bookmark';
    article.dataset.bookmarkId = bookmark.id;
    const title = document.createElement('h3');
    title.textContent = bookmark.title;
    const link = document.createElement('a');
    link.href = bookmark.url;
    link.textContent = bookmark.url;
    link.target = '_blank';
    link.rel = 'noreferrer noopener';
    const saved = document.createElement('time');
    saved.dateTime = bookmark.createdAt;
    saved.textContent = `Saved ${new Date(bookmark.createdAt).toLocaleString()}`;
    article.append(title, link, saved);
    const state = document.createElement('p');
    state.textContent = bookmark.archived ? 'Archived' : 'Active';
    const notes = document.createElement('p');
    notes.className = 'notes';
    notes.textContent = bookmark.notes;
    const tags = document.createElement('p');
    tags.className = 'tags';
    tags.textContent = bookmark.tags.join(' · ');
    const actions = document.createElement('div');
    actions.className = 'actions';
    for (const label of ['Edit', bookmark.archived ? 'Restore' : 'Archive', 'Delete permanently']) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('click', () => {
        if (label === 'Edit') openEditor(bookmark);
        else actOnBookmark(bookmark, label, button);
      });
      actions.append(button);
    }
    article.append(state, notes, tags, actions);
    list.append(article);
  }
}

async function loadBookmarks() {
  const version = ++loadVersion;
  const selectedView = view.value;
  const params = new URLSearchParams({ view: selectedView });
  if (search.value.trim()) params.set('q', search.value);
  if (sort.value !== 'newest') params.set('sort', sort.value);
  for (const tag of selectedTags) params.append('tag', tag);
  const filtered = selectedView !== 'active' || params.has('q') || selectedTags.size > 0;
  count.textContent = 'Loading bookmarks…';
  try {
    const response = await fetch(`/api/bookmarks?${params}`);
    const result = await response.json();
    if (version !== loadVersion) return;
    if (!response.ok) throw new Error(result.error?.message || 'Could not load bookmarks.');
    bookmarks = result.bookmarks;
    dataLocation.textContent = result.dataPath;
    render(filtered);
    document.querySelector('#list-heading').textContent = `${selectedView[0].toUpperCase()}${selectedView.slice(1)} bookmarks`;
    await loadFilterTags(version);
  } catch (error) {
    if (version !== loadVersion) return;
    setStatus(error.message, true);
    count.textContent = 'Results unavailable';
    list.replaceChildren();
    const failure = document.createElement('p');
    failure.className = 'empty';
    failure.textContent = 'Bookmarks could not be loaded.';
    list.append(failure);
  }
}

async function loadFilterTags(version) {
  try {
    const response = await fetch('/api/tags');
    if (!response.ok) throw new Error('Could not load tag filters. Reload to try again.');
    const result = await response.json();
    if (version !== loadVersion) return;
    const labels = [...new Set([...result.tags, ...selectedTags])].sort();
    if (JSON.stringify(labels) === JSON.stringify(tagLabels)) return;
    tagLabels = labels;
    const container = document.querySelector('#filter-tags');
    container.replaceChildren();
    if (!labels.length) container.textContent = 'No tags yet.';
    for (const tag of labels) {
      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selectedTags.has(tag);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selectedTags.add(tag);
        else selectedTags.delete(tag);
        loadBookmarks();
      });
      label.append(checkbox, document.createTextNode(tag));
      container.append(label);
    }
  } catch (error) {
    if (version === loadVersion) setStatus(error.message, true);
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = form.querySelector('button');
  button.disabled = true;
  setStatus('Saving…');
  try {
    const response = await fetch('/api/bookmarks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: form.elements.url.value, title: form.elements.title.value }),
    });
    const result = await response.json();
    if (response.status === 409) {
      const existing = result.error.bookmark;
      setStatus(conflictMessage(existing));
      return;
    }
    if (!response.ok) throw new Error(result.error?.message || 'Could not save bookmark.');
    await loadBookmarks();
    form.reset();
    setStatus(`Saved: ${result.bookmark.title}`);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    button.disabled = false;
  }
});

function conflictMessage(bookmark) {
  return `Already saved: ${bookmark.title}${bookmark.archived ? ' (archived)' : ''} — ${bookmark.url} (ID ${bookmark.id}).`;
}

function focusBookmark(id) {
  const button = list.querySelector(`[data-bookmark-id="${id}"] button`);
  (button || view).focus();
}

async function writeBookmark(id, method, body) {
  const response = await fetch(`/api/bookmarks/${id}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (response.status === 409 && result.error.bookmark) throw new Error(conflictMessage(result.error.bookmark));
  if (!response.ok) throw new Error(result.error?.message || 'Could not update bookmark.');
  return result;
}

async function actOnBookmark(bookmark, action, button) {
  if (action === 'Delete permanently' && !window.confirm(`Permanently delete “${bookmark.title}”? There is no undo or trash.`)) return;
  button.disabled = true;
  try {
    await writeBookmark(bookmark.id, action === 'Delete permanently' ? 'DELETE' : 'PATCH',
      action === 'Delete permanently' ? { identity: bookmark.identity, confirmed: true } : { identity: bookmark.identity, archived: !bookmark.archived });
    await loadBookmarks();
    setStatus(`${action === 'Delete permanently' ? 'Deleted' : action === 'Archive' ? 'Archived' : 'Restored'}: ${bookmark.title}`);
    focusBookmark(bookmark.id);
  } catch (error) {
    setStatus(error.message, true);
    button.disabled = false;
    button.focus();
  }
}

function renderEditingTags() {
  const tags = document.querySelector('#edit-tags');
  tags.replaceChildren();
  for (const tag of editingTags) {
    const item = document.createElement('li');
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = `Remove tag ${tag}`;
    remove.addEventListener('click', () => {
      editingTags = editingTags.filter((value) => value !== tag);
      renderEditingTags();
      tagInput.focus();
    });
    item.append(remove);
    tags.append(item);
  }
}

function addTag() {
  const tag = tagInput.value.trim().toLowerCase();
  if (tag && !editingTags.includes(tag)) editingTags.push(tag);
  tagInput.value = '';
  renderEditingTags();
}

async function openEditor(bookmark) {
  const version = ++editorVersion;
  editingId = bookmark.id;
  editingIdentity = bookmark.identity;
  for (const field of ['url', 'title', 'notes']) editForm.elements[field].value = bookmark[field];
  editingTags = [...bookmark.tags];
  tagInput.value = '';
  editStatus.textContent = '';
  editForm.querySelector('[type="submit"]').disabled = false;
  renderEditingTags();
  const suggestions = document.querySelector('#tag-suggestions');
  suggestions.replaceChildren();
  editor.showModal();
  editForm.elements.url.focus();
  try {
    const response = await fetch('/api/tags');
    const result = await response.json();
    if (version !== editorVersion || !editor.open) return;
    if (!response.ok) throw new Error('Could not load tag suggestions.');
    for (const tag of result.tags) {
      const option = document.createElement('option');
      option.value = tag;
      suggestions.append(option);
    }
  } catch (error) {
    if (version === editorVersion && editor.open) editStatus.textContent = error.message;
  }
}

document.querySelector('#add-tag').addEventListener('click', () => { addTag(); tagInput.focus(); });
tagInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') { event.preventDefault(); addTag(); }
});
document.querySelector('#cancel-edit').addEventListener('click', () => editor.close());
editor.addEventListener('close', () => {
  if (!editor.open) {
    editorVersion++;
    focusBookmark(editingId);
  }
});
editForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const version = editorVersion;
  addTag();
  const button = editForm.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    const result = await writeBookmark(editingId, 'PATCH', {
      identity: editingIdentity,
      url: editForm.elements.url.value, title: editForm.elements.title.value,
      notes: editForm.elements.notes.value, tags: editingTags,
    });
    await loadBookmarks();
    if (version === editorVersion && editor.open) editor.close();
    setStatus(`Updated: ${result.bookmark.title}`);
  } catch (error) {
    if (version === editorVersion && editor.open) {
      editStatus.textContent = error.message;
      editStatus.focus();
    } else setStatus(error.message, true);
  } finally {
    if (version === editorVersion && editor.open) button.disabled = false;
  }
});
view.addEventListener('change', loadBookmarks);
sort.addEventListener('change', loadBookmarks);
filterForm.addEventListener('submit', (event) => { event.preventDefault(); loadBookmarks(); });
document.querySelector('#clear-filters').addEventListener('click', () => {
  filterForm.reset();
  selectedTags.clear();
  loadBookmarks();
  search.focus();
});

const importForm = document.querySelector('#import-form');
const importFile = document.querySelector('#import-file');
const importStatus = document.querySelector('#import-status');
const importPreview = document.querySelector('#import-preview');
const importError = document.querySelector('#import-error');
const cancelImport = document.querySelector('#cancel-import');
const confirmImport = document.querySelector('#confirm-import');
let pendingImport;
let confirmingImport = false;

async function sendBackup(action, body, token) {
  const response = await fetch(`/api/backup/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Stash-Preview': token } : {}) }, body,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || 'Could not process backup.');
  return result;
}

importForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = importForm.querySelector('button');
  button.disabled = true;
  importFile.disabled = true;
  pendingImport = undefined;
  importStatus.textContent = 'Validating backup…';
  try {
    const file = importFile.files[0];
    if (!file) throw new Error('Choose a Stash JSON file.');
    if (file.size > 20 * 1024 * 1024) throw new Error('Backup exceeds the 20 MiB limit.');
    const body = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
    const result = await sendBackup('preview', body);
    pendingImport = { body, token: result.token };
    document.querySelector('#import-summary').textContent = `${result.add} to add; ${result.skip} to skip.`;
    const entries = document.querySelector('#import-entries');
    entries.replaceChildren();
    for (const entry of result.entries) {
      const item = document.createElement('li');
      item.textContent = `${entry.index + 1}. ${entry.title} — ${entry.url}: ${entry.reason || 'Add new bookmark'}`;
      entries.append(item);
    }
    importError.textContent = '';
    importStatus.textContent = '';
    importPreview.showModal();
    cancelImport.focus();
  } catch (error) {
    importStatus.textContent = error.message;
    importStatus.focus();
  } finally {
    button.disabled = false;
    importFile.disabled = false;
  }
});

cancelImport.addEventListener('click', () => importPreview.close());
importPreview.addEventListener('cancel', (event) => {
  if (confirmingImport) event.preventDefault();
});
importPreview.addEventListener('close', () => {
  pendingImport = undefined;
  importForm.reset();
  document.querySelector('#import-entries').replaceChildren();
  importForm.querySelector('button').focus();
});
confirmImport.addEventListener('click', async () => {
  if (!pendingImport || confirmingImport) return;
  confirmingImport = true;
  confirmImport.disabled = true;
  cancelImport.disabled = true;
  importError.textContent = 'Merging… please wait. Confirmation is in progress and cannot be cancelled.';
  try {
    const result = await sendBackup('confirm', pendingImport.body, pendingImport.token);
    importPreview.close();
    importStatus.textContent = `Added ${result.add}; skipped ${result.skip}. Existing bookmarks were not changed.`;
    loadBookmarks();
  } catch (error) {
    importError.textContent = `${error.message} If the connection was lost, check the collection before retrying; repeating a merge cannot overwrite existing URLs.`;
    importError.focus();
  } finally {
    confirmingImport = false;
    confirmImport.disabled = false;
    cancelImport.disabled = false;
  }
});

loadBookmarks();

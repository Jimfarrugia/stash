const form = document.querySelector('#save-form');
const list = document.querySelector('#bookmark-list');
const count = document.querySelector('#count');
const status = document.querySelector('#status');
const dataLocation = document.querySelector('#data-location');
const view = document.querySelector('#view');
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

function render() {
  list.replaceChildren();
  count.textContent = `${bookmarks.length} ${bookmarks.length === 1 ? 'bookmark' : 'bookmarks'}`;
  if (!bookmarks.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No bookmarks yet.';
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
  try {
    const response = await fetch(`/api/bookmarks?view=${selectedView}`);
    const result = await response.json();
    if (version !== loadVersion) return;
    if (!response.ok) throw new Error(result.error?.message || 'Could not load bookmarks.');
    bookmarks = result.bookmarks;
    dataLocation.textContent = result.dataPath;
    render();
    document.querySelector('#list-heading').textContent = `${selectedView[0].toUpperCase()}${selectedView.slice(1)} bookmarks`;
  } catch (error) {
    if (version !== loadVersion) return;
    setStatus(error.message, true);
    list.replaceChildren();
    const failure = document.createElement('p');
    failure.className = 'empty';
    failure.textContent = 'Bookmarks could not be loaded.';
    list.append(failure);
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

loadBookmarks();

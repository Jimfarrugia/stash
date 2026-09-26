const form = document.querySelector('#save-form');
const list = document.querySelector('#bookmark-list');
const count = document.querySelector('#count');
const status = document.querySelector('#status');
const dataLocation = document.querySelector('#data-location');
let bookmarks = [];

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
    list.append(article);
  }
}

async function loadBookmarks() {
  try {
    const response = await fetch('/api/bookmarks');
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message || 'Could not load bookmarks.');
    bookmarks = result.bookmarks;
    dataLocation.textContent = result.dataPath;
    render();
  } catch (error) {
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
      if (!bookmarks.some((bookmark) => bookmark.id === existing.id)) bookmarks.unshift(existing);
      render();
      setStatus(`Already saved: ${existing.title}`);
      return;
    }
    if (!response.ok) throw new Error(result.error?.message || 'Could not save bookmark.');
    bookmarks.unshift(result.bookmark);
    render();
    form.reset();
    setStatus(`Saved: ${result.bookmark.title}`);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    button.disabled = false;
  }
});

loadBookmarks();

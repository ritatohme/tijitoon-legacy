// Utilities shared by index.html and show.html.

const PROGRESS_PREFIX = 'tijitoon:progress:';

function progressKey(seriesId) {
  return PROGRESS_PREFIX + seriesId;
}

function normalize(str) {
  // strip combining diacritics left by NFD decomposition (é → e + U+0301)
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function esc(str) {
  return String(str).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function chLabel(channel) {
  if (channel === 'tiji') return 'Tiji';
  if (channel === 'cartoon-network') return 'Cartoon Network';
  return 'Télétoon';
}

function tagCls(tag) {
  return { ANIME: 'anime', FR: 'fr', KIDS: 'kids', TOON: 'toon' }[tag] || 'toon';
}

const TAG_LABELS = { ANIME: 'Anime', TOON: 'Cartoon', FR: 'Prod. FR', KIDS: 'Préscolaire' };

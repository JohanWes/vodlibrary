/**
 * Shared UI state helpers for frontend pages.
 */

function toSafeSeconds(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return 0;
  }
  return Math.floor(numeric);
}

function formatMediaTime(seconds) {
  const safeSeconds = toSafeSeconds(seconds);
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const remainingSeconds = safeSeconds % 60;

  if (hours > 0) {
    return [
      String(hours).padStart(2, '0'),
      String(minutes).padStart(2, '0'),
      String(remainingSeconds).padStart(2, '0')
    ].join(':');
  }

  return [
    String(minutes).padStart(2, '0'),
    String(remainingSeconds).padStart(2, '0')
  ].join(':');
}

function getShareTimestampLabel(seconds) {
  return `Current time: ${formatMediaTime(seconds)}`;
}

function setFavoriteButtonState(buttonElement, isFavorited, labels = {}) {
  if (!buttonElement) {
    return;
  }

  const activeLabel = labels.activeLabel || 'Remove from Favorites';
  const inactiveLabel = labels.inactiveLabel || 'Add to Favorites';
  const textNode = buttonElement.querySelector('.favorite-text');

  buttonElement.classList.toggle('active', Boolean(isFavorited));

  if (textNode) {
    textNode.textContent = isFavorited ? activeLabel : inactiveLabel;
  } else {
    buttonElement.textContent = isFavorited ? activeLabel : inactiveLabel;
  }
}

const exported = {
  formatMediaTime,
  getShareTimestampLabel,
  setFavoriteButtonState
};

if (typeof window !== 'undefined') {
  window.VideoUIState = exported;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = exported;
}

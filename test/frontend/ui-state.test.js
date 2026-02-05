/**
 * @jest-environment jsdom
 */

const {
  setFavoriteButtonState,
  formatMediaTime,
  getShareTimestampLabel
} = require('../../public/js/ui-state.js');

describe('Shared UI state helpers', () => {
  test('setFavoriteButtonState toggles button class and label text', () => {
    document.body.innerHTML = `
      <button id="favorite-btn" class="favorite-btn">
        <span class="favorite-text"></span>
      </button>
    `;

    const button = document.getElementById('favorite-btn');

    setFavoriteButtonState(button, true, {
      activeLabel: 'Remove from Favorites',
      inactiveLabel: 'Add to Favorites'
    });
    expect(button.classList.contains('active')).toBe(true);
    expect(button.querySelector('.favorite-text').textContent).toBe('Remove from Favorites');

    setFavoriteButtonState(button, false, {
      activeLabel: 'Remove from Favorites',
      inactiveLabel: 'Add to Favorites'
    });
    expect(button.classList.contains('active')).toBe(false);
    expect(button.querySelector('.favorite-text').textContent).toBe('Add to Favorites');
  });

  test('formatMediaTime uses mm:ss for short durations', () => {
    expect(formatMediaTime(5)).toBe('00:05');
    expect(formatMediaTime(65)).toBe('01:05');
  });

  test('formatMediaTime uses hh:mm:ss for long durations', () => {
    expect(formatMediaTime(3661)).toBe('01:01:01');
  });

  test('getShareTimestampLabel returns stable user-facing text', () => {
    expect(getShareTimestampLabel(127)).toBe('Current time: 02:07');
  });
});

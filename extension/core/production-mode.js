// Resolve presets only when creating a book. Saved books keep their own values.
export function productionSettings(mode, length = 'auto') {
  const cap = { short: 5000, auto: 6000, long: 7500 }[length] || 6000;
  const presets = {
    fast: { writeMode: 'batch', maxSectionsPerTurn: 3, textDelayMs: [800, 1500] },
    standard: { writeMode: 'batch', maxSectionsPerTurn: 2, textDelayMs: [1500, 2500] },
    detailed: { writeMode: 'section', maxSectionsPerTurn: 1, textDelayMs: [4000, 9000] },
  };
  if (!presets[mode]) return {};
  return { productionMode: mode, productionModeVersion: 1, maxCharsPerTurn: cap, ...presets[mode] };
}

export function turnDelay(book, wantImages = false) {
  return (!wantImages && book.textDelayMs) || book.transport?.delayMs || [4000, 9000];
}

// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
// SPDX-License-Identifier: Apache-2.0


export function getUnicodeCategory(char: string): string {
  const code = char.codePointAt(0);
  if (!code) return '';

  if (
    (code >= 0x21 && code <= 0x2f) ||
    (code >= 0x3a && code <= 0x40) ||
    (code >= 0x5b && code <= 0x60) ||
    (code >= 0x7b && code <= 0x7e) ||
    (code >= 0xa0 && code <= 0xbf) ||
    (code >= 0x2000 && code <= 0x206f) ||
    (code >= 0x3000 && code <= 0x303f)
  ) {
    return 'P';
  }
  return '';
}

/**
 * Normalizes text to match the training data format used by the EOU model
 *
 * This function applies the following transformations:
 * 1. Converts to lowercase
 * 2. Applies Unicode NFKC normalization
 * 3. Removes all punctuation except apostrophes (') and hyphens (-)
 * 4. Collapses multiple whitespace characters into single spaces
 * 5. Trims leading and trailing whitespace
 *
 * @param text - The input text to normalize
 * @returns The normalized text
 *
 * @example
 * ```typescript
 * normalizeText("Hi, how can I help you today?")
 * // Returns: "hi how can i help you today"
 *
 * normalizeText("I'm a well-trained assistant!")
 * // Returns: "i'm a well-trained assistant"
 *
 * normalizeText("Price: $19.99 (20% off).")
 * // Returns: "price 1999 20 off"
 * ```
 */
export function normalizeText(text: string): string {
  if (!text) return '';

  let normalized = text.toLowerCase().normalize('NFKC');

  normalized = Array.from(normalized)
    .filter((ch) => {
      const category = getUnicodeCategory(ch);
      return !(category.startsWith('P') && ch !== "'" && ch !== '-');
    })
    .join('');

  normalized = normalized.replace(/\s+/g, ' ').trim();

  return normalized;
}

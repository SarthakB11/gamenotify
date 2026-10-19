const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e]/g;
export const MAX_NAME_LENGTH = 32;

/** Strip control / bidi characters and cap length: names are user-controlled input. */
export const sanitizeName = (raw: string): string => {
  const clean = raw.replace(CONTROL_CHARS, '').trim();
  return clean.length > MAX_NAME_LENGTH ? `${clean.slice(0, MAX_NAME_LENGTH - 1)}…` : clean;
};

const SMALL_WORDS = new Set(['of', 'the', 'a', 'an', 'and', 'in', 'on', 'to', 'for']);

/** "SwordOfAzeroth" → "Sword of Azeroth"; "dragon_lair" → "Dragon Lair". */
export const humanizeId = (id: string): string =>
  id
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim()
    .split(/\s+/)
    .map((w, i) => {
      const lower = w.toLowerCase();
      if (i > 0 && SMALL_WORDS.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');

export const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

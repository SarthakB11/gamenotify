export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export const SuppressionReason = {
  DUPLICATE: 'DUPLICATE',
  TYPE_DISABLED: 'TYPE_DISABLED',
  CATEGORY_DISABLED: 'CATEGORY_DISABLED',
  BELOW_RARITY_THRESHOLD: 'BELOW_RARITY_THRESHOLD',
  SELF_ACTION: 'SELF_ACTION',
  GROUPED: 'GROUPED',
  UNKNOWN_RECIPIENT: 'UNKNOWN_RECIPIENT',
} as const;
export type SuppressionReason = (typeof SuppressionReason)[keyof typeof SuppressionReason];

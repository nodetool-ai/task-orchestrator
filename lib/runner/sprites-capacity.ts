export const SPRITE_CAPACITY_ERROR_CODE = "ERR_TASK_ORCH_SPRITE_CAPACITY";

/** Admission raced with another cold boot or warm reservation; retry in queue. */
export class SpriteCapacityError extends Error {
  readonly code = SPRITE_CAPACITY_ERROR_CODE;

  constructor() { super("Waiting for Sprite capacity."); this.name = "SpriteCapacityError"; }
}

export type SpriteCapacityFailure = {
  code: typeof SPRITE_CAPACITY_ERROR_CODE;
  message: string;
};

/**
 * Next.js may place the provider and dispatcher in separate server chunks,
 * producing two copies of this module. `instanceof SpriteCapacityError` then
 * rejects an error created by the other copy even though it is the same typed
 * condition. A string code survives module duplication (and serialization),
 * so capacity remains a retryable queue decision at every boundary.
 */
export function isSpriteCapacityError(error: unknown): error is SpriteCapacityFailure {
  return typeof error === "object" && error !== null
    && "code" in error && error.code === SPRITE_CAPACITY_ERROR_CODE
    && "message" in error && typeof error.message === "string";
}

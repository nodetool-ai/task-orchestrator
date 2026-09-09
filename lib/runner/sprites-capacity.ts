/** Admission raced with another cold boot or warm reservation; retry in queue. */
export class SpriteCapacityError extends Error {
  constructor() { super("Waiting for Sprite capacity."); this.name = "SpriteCapacityError"; }
}

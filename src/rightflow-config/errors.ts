/**
 * An error whose message is written for the person using the plugin: what
 * happened and the next step. Anything else that escapes a tool is reported as
 * an unexpected failure, without its stack.
 */
export class UserFacingError extends Error {
  override readonly name = "UserFacingError";
}

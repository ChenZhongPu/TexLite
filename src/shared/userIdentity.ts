export const MIN_USERNAME_LENGTH = 5;
export const MAX_USERNAME_LENGTH = 50;
export const MAX_DISPLAY_NAME_LENGTH = 50;

const USERNAME_PATTERN = /^[\p{L}\p{N}_.-]+$/u;

/** Validate the syntax and length of a username for a chosen minimum length. */
export function isUsernameSyntaxValid(value: string, minimumLength = MIN_USERNAME_LENGTH): boolean {
  return value.length >= minimumLength && value.length <= MAX_USERNAME_LENGTH && USERNAME_PATTERN.test(value);
}

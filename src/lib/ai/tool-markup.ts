/**
 * Tool-call markup that some models emit as plain text.
 *
 * DeepSeek occasionally writes its tool calls in a DSML-like syntax instead of
 * using the provider's native tool channel:
 *
 *   < | | DSML | | calls>
 *   < | | DSML | | invoke name="search_activities">
 *   ...
 *
 * That text is not a tool call and must never reach the reader as if it were
 * prose — it leaks the plumbing and looks broken. The runtime still executes
 * real tool calls through the provider API; this only removes stray markup from
 * text that is going to be read or stored.
 */

const BLOCK = /<\s*\|+\s*DSML\s*\|+[\s\S]*?<\s*\/\s*\|+\s*DSML\s*\|+\s*calls\s*>/gi;
const SINGLE = /<\s*\|+\s*DSML\s*\|+[^>]*>/gi;
const INVOKE = /<\s*\|+\s*DSML\s*\|+[\s\S]*?(?=\n\s*\n|$)/gi;

export function stripToolMarkup(input: string): string {
  if (!input || !/DSML/i.test(input)) return input ?? "";
  let text = input.replace(BLOCK, "").replace(SINGLE, "");
  // Anything still dangling from an unterminated block.
  text = text.replace(INVOKE, "");
  // Collapse the blank lines the removal leaves behind.
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

/** True when the text looks like it was mostly markup, i.e. nothing useful to show. */
export function isMostlyToolMarkup(input: string): boolean {
  if (!input) return false;
  const stripped = stripToolMarkup(input);
  return stripped.length === 0 && input.trim().length > 0;
}

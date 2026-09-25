/**
 * Phrases that try to address the model rather than answer the tool call, read the same
 * way whether the text came through the MCP proxy or an agent's own fetch, read or shell.
 * Cheap and certain only: this marks content for the record and never decides anything.
 */
const INSTRUCTION_SHAPES: readonly RegExp[] = [
  /\bignore (all |any )?(previous|prior|earlier|above) instructions?\b/i,
  /\bdisregard (all |any )?(previous|prior|earlier|the) (instructions?|rules?|system prompt)\b/i,
  /\byou are now\b/i,
  /\bnew (system )?(instructions?|prompt)\s*:/i,
  /<\s*(system|important_instructions)\s*>/i,
  /\bdo not tell the user\b/i,
  /\b(reveal|print|output) (your|the) (system prompt|instructions)\b/i,
];

export function hasInstructionShape(text: string): boolean {
  return INSTRUCTION_SHAPES.some((shape) => shape.test(text));
}

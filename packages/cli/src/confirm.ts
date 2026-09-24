/** A yes or no asked of the person at the terminal, injected so a test needs no terminal. */

/** The default is the caller's: Enter is yes for what somebody ran the command to do, and no for an undo. */
export type Confirm = (question: string, fallback?: boolean) => Promise<boolean>;

export async function confirmOnTerminal(
  question: string,
  fallback = true,
): Promise<boolean> {
  const { createInterface } = await import('node:readline/promises');
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(`${question}  ${fallback ? '[Y/n]' : '[y/N]'} `);
    const said = answer.trim().toLowerCase();
    if (said === '') return fallback;
    return said.startsWith('y');
  } catch {
    // Ctrl+D, or a stdin that closed. Neither is consent.
    return false;
  } finally {
    prompt.close();
  }
}

/** An answer meant for a yes or no question, typed one question early. */
export function isYesOrNo(answer: string): boolean {
  return ['y', 'n', 'yes', 'no'].includes(answer.trim().toLowerCase());
}

import { isBlocking, scanContent } from '@memnox/content-shield';

const MAX_REPORTED_FINDINGS = 5;

/**
 * Scans proposed content under its real path, then keeps only findings on lines
 * the edit actually introduces — otherwise one pre-existing secret would block
 * every later edit to that file.
 */
export function shieldDenialMessage(
  filePath: string,
  proposedContent: string,
  currentContent: string | null,
): string | null {
  const existingLines = new Set((currentContent ?? '').split('\n'));
  const proposedLines = proposedContent.split('\n');
  const introduced = scanContent(filePath, proposedContent).filter((finding) => {
    const text = proposedLines[finding.line - 1];
    return text !== undefined && !existingLines.has(text);
  });

  const blocking = introduced.filter(isBlocking);
  if (blocking.length === 0) return null;

  const lines = [
    `Memnox Security Shield blocked this write — ${blocking.length} finding(s) introduced in ${filePath}:`,
  ];
  for (const finding of blocking.slice(0, MAX_REPORTED_FINDINGS)) {
    lines.push(
      `  [${finding.severity.toUpperCase()}] ${finding.rule} — ${finding.message} (${finding.excerpt})`,
    );
    lines.push(`    fix: ${finding.fix}`);
  }
  return lines.join('\n');
}

import { homedir, userInfo } from 'node:os';
import { describe, expect, it } from 'vitest';

describe('the test run', () => {
  it('runs in a throwaway home, so a forgotten seam cannot write to the real one', () => {
    expect(homedir()).not.toBe(userInfo().homedir);
    expect(homedir()).toContain('memnox-test-home-');
  });
});

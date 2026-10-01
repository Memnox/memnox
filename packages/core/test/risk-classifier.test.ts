import { describe, expect, it } from 'vitest';
import { RISK_LEVEL } from '../src/constants/risk.constants';
import { classifyRisk } from '../src/policy/risk-classifier';

const DESTRUCTIVE_ACTIONS = [
  'gh.repo-delete',
  'aws.iam-delete',
  'kubectl.delete-namespace',
  'npm.unpublish',
  'aws.s3-rm',
  'aws.ec2-terminate-instances',
  'mcp.deleteRepo',
  'mcp.removeMember',
  'mcp.delete_repo',
] as const;

describe('classifyRisk', () => {
  it.each(DESTRUCTIVE_ACTIONS)('rates %s high', (action) => {
    expect(classifyRisk(action)).toBe(RISK_LEVEL.HIGH);
  });

  it('keeps a dashed read low', () => {
    expect(classifyRisk('gh.repo-view')).toBe(RISK_LEVEL.LOW);
    expect(classifyRisk('kubectl.get-pods')).toBe(RISK_LEVEL.LOW);
    expect(classifyRisk('mcp.listIssues')).toBe(RISK_LEVEL.LOW);
  });

  it('leaves an unknown verb at medium', () => {
    expect(classifyRisk('gh.pr-merge')).toBe(RISK_LEVEL.MEDIUM);
  });

  it('raises a dashed destructive action to critical in production', () => {
    expect(classifyRisk('gh.repo-delete', 'production')).toBe(RISK_LEVEL.CRITICAL);
  });
});

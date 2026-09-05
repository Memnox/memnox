import { describe, expect, it } from 'vitest';
import {
  changesExternalState,
  classifyTool,
  parseOverrides,
  TOOL_CLASS,
} from '../src/discovery/classify';

const tool = (name: string) => ({ name });

/** The table is the test: a classifier defended in prose drifts from what it does. */
const CASES: readonly [string, string][] = [
  ['get_issue', TOOL_CLASS.READ],
  ['get_file_contents', TOOL_CLASS.READ],
  ['list_repositories', TOOL_CLASS.READ],
  ['list_commits', TOOL_CLASS.READ],
  ['search_code', TOOL_CLASS.READ],
  ['search_issues', TOOL_CLASS.READ],
  ['read_file', TOOL_CLASS.READ],
  ['fetch_url', TOOL_CLASS.READ],
  ['find_symbol', TOOL_CLASS.READ],
  ['query_database', TOOL_CLASS.READ],
  ['describe_table', TOOL_CLASS.READ],

  ['create_issue', TOOL_CLASS.WRITE],
  ['create_pull_request', TOOL_CLASS.WRITE],
  ['update_issue', TOOL_CLASS.WRITE],
  ['modify_file', TOOL_CLASS.WRITE],
  ['write_file', TOOL_CLASS.WRITE],
  ['edit_file', TOOL_CLASS.WRITE],
  ['add_label', TOOL_CLASS.WRITE],
  ['insert_row', TOOL_CLASS.WRITE],
  ['set_secret', TOOL_CLASS.WRITE],
  ['merge_pull_request', TOOL_CLASS.WRITE],
  ['push_branch', TOOL_CLASS.WRITE],
  ['apply_migration', TOOL_CLASS.WRITE],
  ['deploy_service', TOOL_CLASS.WRITE],
  ['upload_object', TOOL_CLASS.WRITE],
  ['publish_package', TOOL_CLASS.WRITE],
  ['rename_branch', TOOL_CLASS.WRITE],
  ['post_invoice', TOOL_CLASS.WRITE],

  ['delete_repository', TOOL_CLASS.DESTRUCTIVE],
  ['delete_file', TOOL_CLASS.DESTRUCTIVE],
  ['drop_table', TOOL_CLASS.DESTRUCTIVE],
  ['destroy_stack', TOOL_CLASS.DESTRUCTIVE],
  ['remove_member', TOOL_CLASS.DESTRUCTIVE],
  ['purge_cache', TOOL_CLASS.DESTRUCTIVE],
  ['truncate_table', TOOL_CLASS.DESTRUCTIVE],
  ['revoke_token', TOOL_CLASS.DESTRUCTIVE],

  ['send_message', TOOL_CLASS.COMMUNICATION],
  ['send_email', TOOL_CLASS.COMMUNICATION],
  ['post_message', TOOL_CLASS.COMMUNICATION],
  ['notify_channel', TOOL_CLASS.COMMUNICATION],
  ['reply_comment', TOOL_CLASS.COMMUNICATION],
  ['broadcast_notification', TOOL_CLASS.COMMUNICATION],
  ['send', TOOL_CLASS.COMMUNICATION],

  ['frobnicate_widget', TOOL_CLASS.UNKNOWN],
  ['do_the_thing', TOOL_CLASS.UNKNOWN],
];

describe('classifyTool', () => {
  it.each(CASES)('classifies %s as %s', (name, expected) => {
    expect(classifyTool(tool(name)).class).toBe(expected);
  });

  it('covers at least forty tool names, per the plan', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(40);
  });

  it('prefers a published annotation over the name', () => {
    const result = classifyTool({
      name: 'delete_nothing',
      annotations: { readOnlyHint: true },
    });
    expect(result.class).toBe(TOOL_CLASS.READ);
    expect(result.from).toBe('annotation');
  });

  it('lets an override beat even an annotation, because the operator has seen it run', () => {
    const result = classifyTool(
      { name: 'get_everything', annotations: { readOnlyHint: true } },
      { get_everything: TOOL_CLASS.DESTRUCTIVE },
    );
    expect(result.class).toBe(TOOL_CLASS.DESTRUCTIVE);
    expect(result.from).toBe('override');
  });

  it('counts communication as changing external state, because the data has left', () => {
    expect(changesExternalState(TOOL_CLASS.COMMUNICATION)).toBe(true);
    expect(changesExternalState(TOOL_CLASS.READ)).toBe(false);
    expect(changesExternalState(TOOL_CLASS.UNKNOWN)).toBe(false);
  });
});

describe('the overrides file', () => {
  it('keeps the good entries and names the bad one, rather than refusing the file', () => {
    const { overrides, rejected } = parseOverrides(
      '{"send_payment":"destructive","weird_tool":"purple"}',
    );
    expect(overrides).toEqual({ send_payment: 'destructive' });
    expect(rejected[0]).toContain('weird_tool');
  });

  it('yields nothing from a file that is not JSON, and says why', () => {
    const { overrides, rejected } = parseOverrides('not json at all');
    expect(overrides).toEqual({});
    expect(rejected[0]).toContain('valid JSON');
  });
});

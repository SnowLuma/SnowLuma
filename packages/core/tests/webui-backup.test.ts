import { describe, it, expect } from 'vitest';
import {
  BACKUP_FILES,
  MAX_BACKUP_DECODED_BYTES,
  RestorePreflightError,
  specFor,
  buildBackup,
  prepareRestorePlan,
} from '../src/webui/backup';

const TS = '2026-06-18T00:00:00.000Z';

function reader(map: Record<string, Buffer>) {
  return (name: string): Buffer | null => map[name] ?? null;
}

describe('buildBackup', () => {
  it('includes present non-credential files and skips missing ones', () => {
    const b = buildBackup(reader({
      'runtime.json': Buffer.from('{"webuiPort":5099}'),
      'ui.json': Buffer.from('{}'),
    }), [], { includeCredentials: false }, TS);
    expect(b.version).toBe(1);
    expect(b.app).toBe('snowluma');
    expect(b.createdAt).toBe(TS);
    expect(Object.keys(b.files).sort()).toEqual(['runtime.json', 'ui.json']);
    expect(b.files['runtime.json']).toEqual({ encoding: 'utf8', data: '{"webuiPort":5099}' });
  });

  it('treats all OneBot config (global + per-uin), webui.json, key.pem as credentials', () => {
    const map = {
      'runtime.json': Buffer.from('{}'),
      'webui.json': Buffer.from('{"hash":"x"}'),
      'key.pem': Buffer.from('KEY'),
      'cert.pem': Buffer.from('CERT'),
      'onebot.json': Buffer.from('{"accessToken":"t"}'),
      'onebot_12345.json': Buffer.from('{"accessToken":"t2"}'),
    };
    const perUin = ['onebot_12345.json'];
    const without = buildBackup(reader(map), perUin, { includeCredentials: false }, TS);
    // only public files survive a no-credentials export
    expect(Object.keys(without.files).sort()).toEqual(['cert.pem', 'runtime.json']);
    const withCreds = buildBackup(reader(map), perUin, { includeCredentials: true }, TS);
    expect(Object.keys(withCreds.files).sort()).toEqual(
      ['cert.pem', 'key.pem', 'onebot.json', 'onebot_12345.json', 'runtime.json', 'webui.json'],
    );
  });

  it('does not export a per-UIN file that the import allowlist must reject', () => {
    const b = buildBackup(reader({ 'onebot_1.json': Buffer.from('{}') }), ['onebot_1.json'], { includeCredentials: true }, TS);
    expect(b.files).toEqual({});
  });

  it('base64-encodes binary files (background image)', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const b = buildBackup(reader({ 'ui-assets/background': png }), [], { includeCredentials: false }, TS);
    expect(b.files['ui-assets/background']).toEqual({ encoding: 'base64', data: png.toString('base64') });
  });
});

describe('specFor', () => {
  it('resolves static names and per-uin onebot pattern; rejects others', () => {
    expect(specFor('runtime.json')?.credential).toBe(false);
    expect(specFor('onebot.json')?.credential).toBe(true);
    expect(specFor('onebot_98765.json')).toEqual({ name: 'onebot_98765.json', binary: false, credential: true });
    expect(specFor('onebot_.json')).toBeNull();
    expect(specFor('../evil')).toBeNull();
    expect(specFor('onebot_12.json.bak')).toBeNull();
    expect(specFor('onebot_1.json')).toBeNull();
    expect(specFor('onebot_12345678901.json')).toBeNull();
  });
});

it('BACKUP_FILES marks webui.json / key.pem / onebot.json as credentials, cert.pem public', () => {
  const creds = BACKUP_FILES.filter((f) => f.credential).map((f) => f.name).sort();
  expect(creds).toEqual(['key.pem', 'onebot.json', 'webui.json']);
  expect(specFor('cert.pem')?.credential).toBe(false);
});

describe('prepareRestorePlan — strict semantic preflight', () => {
  const backupWith = (files: Record<string, { encoding: 'utf8' | 'base64'; data: string }>) => ({
    version: 1,
    app: 'snowluma',
    files,
  });

  it.each([
    ['non-object bundle', null, /backup must be an object/i],
    ['wrong app', { version: 1, app: 'other', files: {} }, /not a SnowLuma backup/i],
    ['wrong version', { version: 999, app: 'snowluma', files: {} }, /unsupported backup version/i],
    [
      'malformed entry',
      { version: 1, app: 'snowluma', files: { 'runtime.json': { encoding: 'utf8' } } },
      /bad data for runtime\.json/i,
    ],
  ])('rejects %s through the production preflight entrypoint', (_label, input, expected) => {
    expect(() => prepareRestorePlan(input, {
      restoreCredentials: false,
      readCurrent: () => null,
    })).toThrow(expected);
  });

  it('canonicalizes a recognized older runtime config and reports added fields', () => {
    const prepared = prepareRestorePlan(
      backupWith({
        'runtime.json': { encoding: 'utf8', data: '{"webuiPort":5099}' },
      }),
      { restoreCredentials: false, readCurrent: () => null },
    );

    expect(JSON.parse(prepared.restore[0].data.toString('utf8'))).toEqual({
      webuiPort: 5099,
      hookAutoLoad: false,
      webuiHost: '127.0.0.1',
      webuiTls: { enabled: false },
      trustProxy: '',
      logMaxTotalMb: 1024,
      logRetainDays: 7,
      logPerUin: false,
    });
    expect(prepared.migrated).toEqual([{
      name: 'runtime.json',
      fields: [
        '$.hookAutoLoad',
        '$.logMaxTotalMb',
        '$.logPerUin',
        '$.logRetainDays',
        '$.trustProxy',
        '$.webuiHost',
        '$.webuiTls',
      ],
    }]);
  });

  it('rejects a present runtime value that normalization would silently replace', () => {
    expect(() => prepareRestorePlan(
      backupWith({
        'runtime.json': { encoding: 'utf8', data: '{"webuiPort":70000}' },
      }),
      { restoreCredentials: false, readCurrent: () => null },
    )).toThrowError(expect.objectContaining<Partial<RestorePreflightError>>({
      name: 'RestorePreflightError',
      file: 'runtime.json',
    }));
  });

  it('rejects a notification channel that total normalization would silently drop', () => {
    expect(() => prepareRestorePlan(
      backupWith({
        'notifications.json': {
          encoding: 'utf8',
          data: JSON.stringify({
            version: 1,
            debounceSeconds: 30,
            channels: [{ id: 'ops', name: 'Ops', url: 'file:///tmp/leak', bodyTemplate: '{}', enabled: true }],
          }),
        },
      }),
      { restoreCredentials: false, readCurrent: () => null },
    )).toThrow(/notifications\.json.*channels/i);
  });

  it('does not validate credential files that the operator chose to skip', () => {
    const prepared = prepareRestorePlan(
      backupWith({
        'webui.json': { encoding: 'utf8', data: '{definitely broken' },
        'runtime.json': { encoding: 'utf8', data: '{}' },
      }),
      { restoreCredentials: false, readCurrent: () => null },
    );

    expect(prepared.skipped).toEqual(['webui.json']);
    expect(prepared.restore.map((entry) => entry.name)).toEqual(['runtime.json']);
  });

  it('does not require even a well-formed entry envelope for a skipped credential', () => {
    const prepared = prepareRestorePlan({
      version: 1,
      app: 'snowluma',
      files: {
        'webui.json': { encoding: 'rot13' },
        'runtime.json': { encoding: 'utf8', data: '{}' },
      },
    }, { restoreCredentials: false, readCurrent: () => null });

    expect(prepared.skipped).toEqual(['webui.json']);
    expect(prepared.restore.map((entry) => entry.name)).toEqual(['runtime.json']);
  });

  it('rejects malformed WebUI credential state when credential restore is enabled', () => {
    expect(() => prepareRestorePlan(
      backupWith({
        'webui.json': {
          encoding: 'utf8',
          data: JSON.stringify({ passwordHash: 'zz', passwordSalt: '00', mustChangePassword: false }),
        },
      }),
      { restoreCredentials: true, readCurrent: () => null, listCurrentOneBotNames: () => [] },
    )).toThrow(/webui\.json.*passwordHash/i);
  });

  it('does not copy malformed sensitive JSON contents into the reported error', () => {
    const secret = 'super-secret-token';
    let thrown: unknown;
    try {
      prepareRestorePlan(
        backupWith({
          'onebot.json': { encoding: 'utf8', data: secret },
        }),
        { restoreCredentials: true, readCurrent: () => null, listCurrentOneBotNames: () => [] },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toEqual(expect.objectContaining({
      name: 'RestorePreflightError',
      message: 'onebot.json: invalid JSON',
    }));
    expect((thrown as Error).message).not.toContain(secret);
  });

  it('rejects a background blob whose bytes are not a supported image', () => {
    expect(() => prepareRestorePlan(
      backupWith({
        'ui-assets/background': {
          encoding: 'base64',
          data: Buffer.from('not an image').toString('base64'),
        },
      }),
      { restoreCredentials: false, readCurrent: () => null },
    )).toThrow(/ui-assets\/background.*PNG.*JPEG.*WebP/i);
  });

  it('rejects an invalid effective TLS pair', () => {
    expect(() => prepareRestorePlan(
      backupWith({
        'cert.pem': { encoding: 'utf8', data: 'not a certificate' },
        'key.pem': { encoding: 'utf8', data: 'not a private key' },
      }),
      { restoreCredentials: true, readCurrent: () => null },
    )).toThrow(/cert\.pem.*key\.pem/i);
  });

  it('fails fast when TLS validation needs a malformed current runtime config', () => {
    const secret = 'runtime-secret-fragment';
    let thrown: unknown;

    try {
      prepareRestorePlan(
        backupWith({
          'cert.pem': { encoding: 'utf8', data: 'not a certificate' },
        }),
        {
          restoreCredentials: false,
          readCurrent: (name) => name === 'runtime.json' ? Buffer.from(secret) : null,
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toEqual(expect.objectContaining({
      name: 'RestorePreflightError',
      message: 'runtime.json: effective runtime config is invalid JSON',
    }));
    expect((thrown as Error).message).not.toContain(secret);
  });

  it('assigns restrictive modes to every credential file', () => {
    const validAuth = {
      passwordHash: 'ab'.repeat(64),
      passwordSalt: 'cd'.repeat(16),
      mustChangePassword: false,
      generatedAt: TS,
      updatedAt: TS,
    };
    const prepared = prepareRestorePlan(
      backupWith({
        'webui.json': { encoding: 'utf8', data: JSON.stringify(validAuth) },
      }),
      { restoreCredentials: true, readCurrent: () => null, listCurrentOneBotNames: () => [] },
    );

    expect(prepared.restore).toEqual([
      expect.objectContaining({ name: 'webui.json', mode: 0o600 }),
    ]);
  });

  it('rejects an encoding that does not match the allowlisted file kind', () => {
    expect(() => prepareRestorePlan(
      backupWith({
        'runtime.json': { encoding: 'base64', data: Buffer.from('{}').toString('base64') },
      }),
      { restoreCredentials: false, readCurrent: () => null },
    )).toThrow(/runtime\.json.*encoding must be utf8/i);
  });

  it('rejects non-canonical base64 instead of accepting Node partial decoding', () => {
    expect(() => prepareRestorePlan(
      backupWith({
        'ui-assets/background': { encoding: 'base64', data: '%%%%' },
      }),
      { restoreCredentials: false, readCurrent: () => null },
    )).toThrow(/background.*canonical base64/i);
  });

  it('enforces the decoded-byte cap independently of request Content-Length', () => {
    expect(() => prepareRestorePlan(
      backupWith({
        'cert.pem': { encoding: 'utf8', data: 'x'.repeat(MAX_BACKUP_DECODED_BYTES + 1) },
      }),
      { restoreCredentials: false, readCurrent: () => null },
    )).toThrow(/decoded bytes/i);
  });

  it('rejects lossy normalization in global SnowLuma settings', () => {
    expect(() => prepareRestorePlan(
      backupWith({
        'snowluma.json': {
          encoding: 'utf8',
          data: JSON.stringify({ rkey: { fallbackServers: ['file:///tmp/not-http'] }, musicSignUrl: '' }),
        },
      }),
      { restoreCredentials: false, readCurrent: () => null },
    )).toThrow(/snowluma\.json.*fallbackServers/i);
  });

  it('rejects a present invalid UI value instead of silently defaulting it', () => {
    expect(() => prepareRestorePlan(
      backupWith({
        'ui.json': {
          encoding: 'utf8',
          data: JSON.stringify({ appearance: { mode: 'ultraviolet' } }),
        },
      }),
      { restoreCredentials: false, readCurrent: () => null },
    )).toThrow(/ui\.json.*mode/i);
  });

  it('migrates a known legacy per-account OneBot layout to a canonical overlay', () => {
    const prepared = prepareRestorePlan(
      backupWith({
        'onebot_12345.json': {
          encoding: 'utf8',
          data: JSON.stringify({
            httpServers: [{ name: 'legacy-http', port: '3100' }],
            messageFormat: 'string',
            reportSelfMessage: true,
          }),
        },
      }),
      { restoreCredentials: true, readCurrent: () => null },
    );

    const canonical = JSON.parse(prepared.restore[0].data.toString('utf8'));
    expect(canonical.mode).toBe('overlay');
    expect(canonical.networks.httpServers).toEqual([expect.objectContaining({
      name: 'legacy-http',
      port: 3100,
      messageFormat: 'string',
      reportSelfMessage: true,
    })]);
    expect(prepared.migrated).toEqual([{ name: 'onebot_12345.json', fields: ['$'] }]);
  });

  it('rejects a OneBot adapter that compatibility parsing would discard', () => {
    expect(() => prepareRestorePlan(
      backupWith({
        'onebot_12345.json': {
          encoding: 'utf8',
          data: JSON.stringify({ networks: { httpServers: [{ name: 'broken', port: 0 }] } }),
        },
      }),
      { restoreCredentials: true, readCurrent: () => null },
    )).toThrow(/onebot_12345\.json.*port/i);
  });

  it('rejects enabling TLS when the effective pair is incomplete', () => {
    expect(() => prepareRestorePlan(
      backupWith({
        'runtime.json': {
          encoding: 'utf8',
          data: JSON.stringify({ webuiTls: { enabled: true } }),
        },
      }),
      { restoreCredentials: false, readCurrent: () => null },
    )).toThrow(/cert\.pem.*key\.pem.*incomplete/i);
  });

  it('rejects a UI config that claims a background image which is absent from the effective overlay', () => {
    expect(() => prepareRestorePlan(
      backupWith({
        'ui.json': {
          encoding: 'utf8',
          data: JSON.stringify({
            appearance: {
              background: {
                type: 'image',
                hasImage: true,
                imageMime: 'image/png',
                imageVersion: 1,
              },
            },
          }),
        },
      }),
      { restoreCredentials: false, readCurrent: () => null },
    )).toThrow(/ui\.json.*background.*missing/i);
  });

  it('does not expose malformed current UI contents while validating a restored background', () => {
    const secret = 'ui-secret-fragment';
    let thrown: unknown;

    try {
      prepareRestorePlan(
        backupWith({
          'ui-assets/background': {
            encoding: 'base64',
            data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64'),
          },
        }),
        {
          restoreCredentials: false,
          readCurrent: (name) => name === 'ui.json' ? Buffer.from(secret) : null,
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toEqual(expect.objectContaining({
      name: 'RestorePreflightError',
      message: 'ui.json: effective UI config is invalid JSON',
    }));
    expect((thrown as Error).message).not.toContain(secret);
  });

  it('rejects a OneBot global/per-account overlay that is invalid only after merge', () => {
    expect(() => prepareRestorePlan(
      backupWith({
        'onebot.json': {
          encoding: 'utf8',
          data: JSON.stringify({
            httpServers: [{ name: 'dup', port: 3100 }],
          }),
        },
        'onebot_12345.json': {
          encoding: 'utf8',
          data: JSON.stringify({
            mode: 'overlay',
            wsClients: [{ name: 'dup', url: 'ws://127.0.0.1:9000' }],
          }),
        },
      }),
      { restoreCredentials: true, readCurrent: () => null, listCurrentOneBotNames: () => [] },
    )).toThrow(/onebot_12345\.json.*duplicated/i);
  });

  it('validates current per-account overlays affected by a restored global OneBot config', () => {
    const currentPerUin = Buffer.from(JSON.stringify({
      mode: 'overlay',
      wsClients: [{ name: 'dup', url: 'ws://127.0.0.1:9000' }],
    }));
    expect(() => prepareRestorePlan(
      backupWith({
        'onebot.json': {
          encoding: 'utf8',
          data: JSON.stringify({ httpServers: [{ name: 'dup', port: 3100 }] }),
        },
      }),
      {
        restoreCredentials: true,
        readCurrent: (name) => name === 'onebot_54321.json' ? currentPerUin : null,
        listCurrentOneBotNames: () => ['onebot_54321.json'],
      },
    )).toThrow(/onebot_54321\.json.*duplicated/i);
  });

  it('canonicalizes a per-account overlay against the effective global OneBot config', () => {
    const currentGlobal = Buffer.from(JSON.stringify({
      messageFormat: 'string',
      reportSelfMessage: true,
      statusCommand: { trigger: '#global' },
      notifications: { channelIds: ['ops'] },
    }));
    const prepared = prepareRestorePlan(
      backupWith({
        'onebot_12345.json': {
          encoding: 'utf8',
          data: JSON.stringify({
            mode: 'overlay',
            httpClients: [{ name: 'remote', url: 'https://example.test/onebot' }],
          }),
        },
      }),
      {
        restoreCredentials: true,
        readCurrent: (name) => name === 'onebot.json' ? currentGlobal : null,
      },
    );

    const canonical = JSON.parse(prepared.restore[0].data.toString('utf8'));
    expect(canonical.mode).toBe('overlay');
    expect(canonical.networks.httpClients[0]).toEqual(expect.objectContaining({
      messageFormat: 'string',
      reportSelfMessage: true,
    }));
    expect(canonical.statusCommand.trigger).toBe('#global');
    expect(canonical.notifications.channelIds).toEqual(['ops']);
  });

  it('accepts lossless scalar spellings already supported by the runtime owner', () => {
    const prepared = prepareRestorePlan(
      backupWith({
        'runtime.json': {
          encoding: 'utf8',
          data: JSON.stringify({ webuiPort: '5099', hookAutoLoad: 1, webuiTls: { enabled: 0 } }),
        },
      }),
      { restoreCredentials: false, readCurrent: () => null },
    );

    const canonical = JSON.parse(prepared.restore[0].data.toString('utf8'));
    expect(canonical.webuiPort).toBe(5099);
    expect(canonical.hookAutoLoad).toBe(true);
    expect(canonical.webuiTls.enabled).toBe(false);
  });

  it('accepts owner-supported whitespace trimming without accepting changed values', () => {
    const prepared = prepareRestorePlan(
      backupWith({
        'snowluma.json': {
          encoding: 'utf8',
          data: JSON.stringify({
            rkey: { fallbackServers: ['  https://a.example/r '] },
            musicSignUrl: '  https://sign.example/card ',
          }),
        },
      }),
      { restoreCredentials: false, readCurrent: () => null },
    );

    expect(JSON.parse(prepared.restore[0].data.toString('utf8'))).toEqual({
      rkey: { fallbackServers: ['https://a.example/r'] },
      musicSignUrl: 'https://sign.example/card',
    });
  });

  it('does not read an unrelated current global OneBot file for a snapshot restore', () => {
    const prepared = prepareRestorePlan(
      backupWith({
        'onebot_12345.json': {
          encoding: 'utf8',
          data: JSON.stringify({ mode: 'snapshot' }),
        },
      }),
      {
        restoreCredentials: true,
        readCurrent: (name) => name === 'onebot.json' ? Buffer.from('{broken') : null,
      },
    );

    expect(JSON.parse(prepared.restore[0].data.toString('utf8')).mode).toBe('snapshot');
  });

  it('canonicalizes owner-supported OneBot notification id trimming and deduplication', () => {
    const prepared = prepareRestorePlan(
      backupWith({
        'onebot_12345.json': {
          encoding: 'utf8',
          data: JSON.stringify({
            mode: 'snapshot',
            notifications: { channelIds: [' ops ', 'ops'] },
          }),
        },
      }),
      { restoreCredentials: true, readCurrent: () => null },
    );

    const canonical = JSON.parse(prepared.restore[0].data.toString('utf8'));
    expect(canonical.notifications.channelIds).toEqual(['ops']);
  });

  it('accepts disabled OneBot clients whose legacy config omitted the unused URL', () => {
    const prepared = prepareRestorePlan(
      backupWith({
        'onebot_12345.json': {
          encoding: 'utf8',
          data: JSON.stringify({
            mode: 'snapshot',
            networks: {
              httpClients: [{ name: 'http-off', enabled: false }],
              wsClients: [{ name: 'ws-off', enabled: false }],
            },
          }),
        },
      }),
      { restoreCredentials: true, readCurrent: () => null },
    );

    const canonical = JSON.parse(prepared.restore[0].data.toString('utf8'));
    expect(canonical.networks.httpClients[0].url).toBe('');
    expect(canonical.networks.wsClients[0].url).toBe('');
  });

  it('measures a OneBot status trigger after owner-supported whitespace trimming', () => {
    const trigger = 'a'.repeat(32);
    const prepared = prepareRestorePlan(
      backupWith({
        'onebot_12345.json': {
          encoding: 'utf8',
          data: JSON.stringify({
            mode: 'snapshot',
            statusCommand: { trigger: ` ${trigger} ` },
          }),
        },
      }),
      { restoreCredentials: true, readCurrent: () => null },
    );

    const canonical = JSON.parse(prepared.restore[0].data.toString('utf8'));
    expect(canonical.statusCommand.trigger).toBe(trigger);
  });

  it('preserves the missing musicSignUrl migration sentinel in an older global config', () => {
    const prepared = prepareRestorePlan(
      backupWith({
        'snowluma.json': {
          encoding: 'utf8',
          data: JSON.stringify({ rkey: { fallbackServers: [] } }),
        },
        'onebot.json': {
          encoding: 'utf8',
          data: JSON.stringify({ musicSignUrl: 'https://legacy.example/sign' }),
        },
      }),
      {
        restoreCredentials: true,
        readCurrent: () => null,
        listCurrentOneBotNames: () => [],
      },
    );

    const byName = Object.fromEntries(prepared.restore.map((file) => [
      file.name,
      JSON.parse(file.data.toString('utf8')),
    ]));
    expect(byName['snowluma.json']).not.toHaveProperty('musicSignUrl');
    expect(byName['onebot.json'].musicSignUrl).toBe('https://legacy.example/sign');
  });

  it('preserves legacy per-account defaults that apply to inherited global adapters', () => {
    const prepared = prepareRestorePlan(
      backupWith({
        'onebot.json': {
          encoding: 'utf8',
          data: JSON.stringify({ httpServers: [{ name: 'global-http', port: 3100 }] }),
        },
        'onebot_12345.json': {
          encoding: 'utf8',
          data: JSON.stringify({ messageFormat: 'string', reportSelfMessage: true }),
        },
      }),
      {
        restoreCredentials: true,
        readCurrent: () => null,
        listCurrentOneBotNames: () => [],
      },
    );

    const perUin = prepared.restore.find((file) => file.name === 'onebot_12345.json')!;
    expect(JSON.parse(perUin.data.toString('utf8')).networks.httpServers[0]).toEqual(expect.objectContaining({
      name: 'global-http',
      messageFormat: 'string',
      reportSelfMessage: true,
    }));
  });

  it('rejects per-account filenames that startup would immediately delete', () => {
    expect(() => prepareRestorePlan(
      backupWith({
        'onebot_1.json': { encoding: 'utf8', data: JSON.stringify({ mode: 'snapshot' }) },
      }),
      { restoreCredentials: true, readCurrent: () => null },
    )).toThrow(/unknown file/i);
  });

  it('rejects syntactically invalid WebUI and OneBot bind hosts', () => {
    expect(() => prepareRestorePlan(
      backupWith({
        'runtime.json': { encoding: 'utf8', data: JSON.stringify({ webuiHost: 'bad host' }) },
      }),
      { restoreCredentials: false, readCurrent: () => null },
    )).toThrow(/runtime\.json.*webuiHost/i);

    expect(() => prepareRestorePlan(
      backupWith({
        'onebot_12345.json': {
          encoding: 'utf8',
          data: JSON.stringify({
            mode: 'snapshot',
            networks: { httpServers: [{ name: 'bad', host: 'bad host', port: 3100 }] },
          }),
        },
      }),
      { restoreCredentials: true, readCurrent: () => null },
    )).toThrow(/onebot_12345\.json.*host/i);
  });

  it('keeps valid IPv6 bind hosts while applying syntax checks', () => {
    const prepared = prepareRestorePlan(
      backupWith({
        'runtime.json': { encoding: 'utf8', data: JSON.stringify({ webuiHost: '::' }) },
        'onebot_12345.json': {
          encoding: 'utf8',
          data: JSON.stringify({
            mode: 'snapshot',
            networks: { httpServers: [{ name: 'v6', host: '::1', port: 3100 }] },
          }),
        },
      }),
      { restoreCredentials: true, readCurrent: () => null },
    );

    expect(prepared.restore.map((file) => file.name).sort()).toEqual(['onebot_12345.json', 'runtime.json']);
  });

  it('rejects malformed IPv6 zone syntax that Node cannot bind', () => {
    expect(() => prepareRestorePlan(
      backupWith({
        'runtime.json': { encoding: 'utf8', data: JSON.stringify({ webuiHost: '::1%bad%extra' }) },
      }),
      { restoreCredentials: false, readCurrent: () => null },
    )).toThrow(/runtime\.json.*webuiHost/i);
  });

  it('ignores untouched invalid PEM files while effective TLS is disabled', () => {
    const prepared = prepareRestorePlan(
      backupWith({
        'runtime.json': { encoding: 'utf8', data: '{}' },
      }),
      {
        restoreCredentials: false,
        readCurrent: (name) => name === 'cert.pem' || name === 'key.pem' ? Buffer.from('invalid PEM') : null,
      },
    );

    expect(prepared.restore.map((file) => file.name)).toEqual(['runtime.json']);
  });

  it('does not inspect invalid per-UIN files that startup cleanup owns', () => {
    const prepared = prepareRestorePlan(
      backupWith({
        'onebot.json': { encoding: 'utf8', data: '{}' },
      }),
      {
        restoreCredentials: true,
        readCurrent: (name) => {
          if (name === 'onebot_1.json') throw new Error('invalid UIN file should not be read');
          return null;
        },
        listCurrentOneBotNames: () => ['onebot_1.json'],
      },
    );

    expect(prepared.restore.map((file) => file.name)).toEqual(['onebot.json']);
  });
});

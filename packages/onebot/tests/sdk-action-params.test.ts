import { describe, expect, it } from 'vitest';
import { actionParams } from '../../sdk/tests/fixtures/action-contracts';
import { actions as extended } from '../src/actions/extended';
import { actions as albums } from '../src/actions/group-album';
import { actions as groupAdmin } from '../src/actions/group-admin';
import { actions as qzone } from '../src/actions/qzone';
import { actions as qzonePublic } from '../src/actions/qzone-public';
import { actions as streamDownload } from '../src/actions/stream-download';
import { actions as streamFile } from '../src/actions/stream-file';

const actions = [
    ...extended,
    ...albums,
    ...groupAdmin,
    ...qzone,
    ...qzonePublic,
    ...streamDownload,
    ...streamFile,
];
const examples = Object.entries(actionParams).filter(
    ([name]) => name !== '.handle_quick_operation_async',
);

describe('SDK action parameter examples', () => {
    it.each(examples)('%s matches the server input contract', (name, params) => {
        const action = actions.find((entry) => entry.names.includes(name));

        if (!action) {
            throw new Error(`No server action for SDK example ${name}`);
        }

        expect(Object.keys(params).sort()).toEqual(
            action
                .describe()
                .params.map(({ name }) => name)
                .sort(),
        );
        expect(action.parse(params)).toMatchObject({ ok: true });
    });
});

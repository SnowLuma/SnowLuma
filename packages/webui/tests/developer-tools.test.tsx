import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  DEVELOPER_CRASH_MESSAGE,
  DeveloperCrashProbe,
  developerCrashReducer,
} from '../src/components/settings/developer-tools';
import { ErrorPage } from '../src/components/pages/status-screens';
import { SETTINGS_TABS } from '../src/router';

describe('developer settings tools', () => {
  it('keeps the developer page in the public settings route contract', () => {
    expect(SETTINGS_TABS).toContain('developer');
  });

  it('promotes a confirmed crash into the route error screen', () => {
    const requested = developerCrashReducer(false, 'confirm');
    expect(() => renderToStaticMarkup(
      <DeveloperCrashProbe requested={requested} />,
    )).toThrowError(DEVELOPER_CRASH_MESSAGE);

    const html = renderToStaticMarkup(
      <ErrorPage error={new Error(DEVELOPER_CRASH_MESSAGE)} reset={() => undefined} />,
    );
    expect(html).toContain('页面出错了');
    expect(html).toContain('重试');
    expect(html).toContain(DEVELOPER_CRASH_MESSAGE);
  });
});

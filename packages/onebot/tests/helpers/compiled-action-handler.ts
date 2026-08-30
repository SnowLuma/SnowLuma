import { defineAction, type RegisteredActionSpec } from '../../src/action-kit';
import { ApiHandler, type ApiActionContext } from '../../src/api-handler';
import { compileActionRegistry, RAW_ACTION_RESERVATIONS } from '../../src/actions';
import type { ApiResponse, JsonObject } from '../../src/types';

type TestActionRun = (
  params: JsonObject,
  context: ApiActionContext,
) => Promise<ApiResponse> | ApiResponse;

/** A test-only normal ActionSpec that still travels through the complete
 * compiled-registry constructor path. */
export function testAction(name: string, run: TestActionRun): RegisteredActionSpec {
  return defineAction({
    name,
    params: {},
    run: (params, context) => run(params, context),
  });
}

/** Construct an ApiHandler from an isolated but complete namespace. The raw
 * quick-operation reservation is mandatory, matching the production shape. */
export function createCompiledTestHandler(
  context: ApiActionContext,
  specs: readonly RegisteredActionSpec[] = [],
  uin?: number,
): ApiHandler {
  const registry = compileActionRegistry(
    [{ category: 'test', actions: specs }],
    RAW_ACTION_RESERVATIONS,
  );
  return new ApiHandler(context, uin, registry);
}

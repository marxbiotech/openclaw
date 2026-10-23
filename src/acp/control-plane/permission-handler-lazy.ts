import type { AcpManagerPermissionHandler } from "./manager.types.js";
import type { AcpPermissionHandlerParams } from "./permission-handler.js";

/** Defers approval transport until a native harness asks while keeping one handler per turn. */
export function createLazyAcpPermissionHandler(
  params: AcpPermissionHandlerParams,
): AcpManagerPermissionHandler {
  let handler: Promise<AcpManagerPermissionHandler> | undefined;
  return async (request, context) => {
    handler ??= import("./permission-handler.js").then(({ createAcpPermissionHandler }) =>
      createAcpPermissionHandler(params),
    );
    return await (
      await handler
    )(request, context);
  };
}

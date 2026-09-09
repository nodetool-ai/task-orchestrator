import { dispatchAppOperation, resolveOperation } from "../app-api";
import type { AppApiContext } from "../app-api/types";
import { executeCodeAct, type CodeActExecuteRequest, type CodeActExecuteResult } from "./bridge";
import { codeActCatalogForContext } from "./catalog";

const TURN_CONTROL_OPERATIONS = new Set([
  "timer__sleep",
  "ask_parent",
  "report_result",
  "raise",
  "await_session",
  "propose_spec",
  "propose_implementation_plan",
]);

export interface AppCodeActExecuteRequest
  extends Omit<CodeActExecuteRequest, "catalog" | "dispatch"> {
  context: AppApiContext;
  /** Rebuild trusted mutable policy before cataloguing and every subcall. */
  resolveContext?: () => Promise<AppApiContext>;
}

/**
 * Control-plane adapter for the generic execution bridge. This module is kept
 * separate so Claude/Codex workers can import the sandbox without pulling the
 * application registry (and therefore Postgres) into their process.
 */
export async function executeAppCodeAct(request: AppCodeActExecuteRequest): Promise<CodeActExecuteResult> {
  const { context, resolveContext, ...rest } = request;
  const currentContext = async () => resolveContext ? resolveContext() : context;
  const catalogContext = await currentContext();
  let acceptingCalls = true;
  return executeCodeAct({
    ...rest,
    catalog: codeActCatalogForContext(catalogContext),
    dispatch: async (operation, input, metadata) => {
      if (!acceptingCalls) {
        throw new Error("CodeAct execution was closed by a successful lifecycle operation");
      }
      const result = await dispatchAppOperation(
        operation,
        input,
        { ...await currentContext(), ...metadata } as AppApiContext & typeof metadata,
      );
      const canonical = resolveOperation(operation)?.name ?? operation.replace(/^(app|tools)\./, "");
      if (!result.isError && TURN_CONTROL_OPERATIONS.has(canonical)) acceptingCalls = false;
      return result;
    },
  });
}

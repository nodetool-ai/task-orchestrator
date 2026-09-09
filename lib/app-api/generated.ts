import { APP_API_DESCRIPTORS } from "./registry";

/** Type-level views intentionally derive from the descriptor tuple/catalog.
 * Consumers can use these without depending on the implementation registry. */
export type AppApiOperationName = (typeof APP_API_DESCRIPTORS)[number]["name"];
export type AppApiSdkPath = (typeof APP_API_DESCRIPTORS)[number]["sdkPath"];
export type AppApiAlias = (typeof APP_API_DESCRIPTORS)[number]["aliases"][number];

export const APP_API_OPERATION_NAMES = APP_API_DESCRIPTORS.map((d) => d.name) as readonly AppApiOperationName[];
export const APP_API_SDK_PATHS = APP_API_DESCRIPTORS.map((d) => d.sdkPath) as readonly AppApiSdkPath[];

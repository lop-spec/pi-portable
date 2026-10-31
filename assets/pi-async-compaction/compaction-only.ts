import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { install } from "./index";

// Chat-only and isolated profiles keep their existing main-request policy.
export default function compactionOnly(pi: ExtensionAPI): void {
  install(pi, { mainReasoningContextPolicy: false });
}

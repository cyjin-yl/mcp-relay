import { ComputerError } from "./types.js";
import type { WorkspaceProvider } from "./workspace-types.js";

/**
 * macOS generic AX/CGEvent input shares the login session's focus and IME.
 * CGVirtualDisplay does not establish an input seat, and releasing its object
 * alone does not prove that WindowServer removed the display. Never advertise
 * the existing foreground backend as an isolated workspace.
 *
 * The reviewed SpaceO revision documents partial input-route coverage and
 * automatic termination of launched applications on abandoned leases. Neither
 * behavior satisfies relay's strict foreground-input and app-preservation
 * contract. A native provider must pass those gates before this adapter opens.
 */
export function createMacosWorkspaceProvider(): WorkspaceProvider {
  const unavailable = () => new ComputerError("isolated_workspace_unavailable",
    "macOS isolated desktop input and lossless display recovery have not been verified. No virtual display was created; use an explicitly approved foreground computer session.");
  return {
    id: "macos-workspace-unavailable",
    async probe() {
      return {
        available: false, isolated: false, canAdoptWindows: false, recovery: "unsupported",
        independentWatchdog: false, unicodeText: false, clipboardBoundary: "unsupported",
        reason: "macOS virtual displays do not independently isolate keyboard focus or IME. The current native provider cannot guarantee foreground isolation and preservation of unsaved applications after a crash.",
        details: { physicalFallback: false, setupRequired: "verified native isolation and window-return provider",
          reviewedSpaceORevision: "23918951d67da6567703ecaba21b03d1c0154dd3",
          blockers: ["input-route-isolation-not-verified", "abandoned-launched-apps-can-be-terminated",
            "virtual-display-retirement-must-be-confirmed"] }
      };
    },
    async open() { throw unavailable(); },
    async renew() { throw unavailable(); },
    async inspect() { throw unavailable(); },
    async capture() { throw unavailable(); },
    async act() { throw unavailable(); },
    async recover(resource) {
      if (!resource) return { complete: true, outcome: "no-resources", inputRevoked: true, ownedDisplayRemoved: true };
      return { complete: false, outcome: "cleanup-pending", inputRevoked: true, ownedDisplayRemoved: false,
        details: { reason: "An unrecognized macOS resource requires its original verified provider." } };
    }
  };
}

import type { WorkspaceProvider } from "./workspace-types.js";
import { ComputerError } from "./types.js";

export async function createWorkspaceProvider(platform: NodeJS.Platform = process.platform): Promise<WorkspaceProvider> {
  switch (platform) {
    case "win32": return (await import("./workspace-windows.js")).createWindowsWorkspaceProvider();
    case "android": return (await import("./workspace-android.js")).createAndroidWorkspaceProvider();
    case "linux": return (await import("./workspace-linux.js")).createLinuxWorkspaceProvider();
    case "darwin": return (await import("./workspace-macos.js")).createMacosWorkspaceProvider();
    default: throw new ComputerError("isolated_workspace_unavailable", "No isolated workspace provider exists for this platform.");
  }
}

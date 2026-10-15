export type PermState = "granted" | "denied" | "prompt" | "unknown";
export interface CallReadiness {
  platform: "ios" | "android" | "web";
  ok: boolean;
  mic: PermState;
  cam: PermState | "n/a";
  /** user-facing, platform-specific recovery text when !ok */
  hint?: string;
  /** the platform can deep-link to its settings screen */
  canOpenSettings: boolean;
}
export interface ReadyInput {
  video: boolean;
}
/** Probes are injected so each platform module is testable without a browser. Never prompts. */
export interface Probe {
  query(name: "microphone" | "camera"): Promise<PermState>;
}
export const browserProbe: Probe = {
  async query(name) {
    try {
      const p = await navigator.permissions.query({ name: name as PermissionName });
      return p.state as PermState;
    } catch {
      return "unknown";
    }
  },
};

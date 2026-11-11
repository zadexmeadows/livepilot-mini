type SessionLimits = {
  runUntilStopped: boolean;
  maxMessages: number;
  sessionMessagesSent: number;
  stopMode: string;
  stopValue: number | null;
  stopAt: Date | null;
};

// This controls configured completion only. Cancellation, authentication checks,
// YouTube restrictions, errors and the repeat interval stay in the worker.
export function getSessionCompletionReason(automation: SessionLimits, startedAt: Date, now = Date.now()) {
  if (automation.runUntilStopped) return null;
  if (automation.sessionMessagesSent >= automation.maxMessages) return "Maximum messages per session reached.";
  if (automation.stopMode === "MESSAGES" && automation.stopValue && automation.sessionMessagesSent >= automation.stopValue) return "Configured message limit reached.";
  if (automation.stopMode === "MINUTES" && automation.stopValue && now >= startedAt.getTime() + automation.stopValue * 60_000) return "Configured duration reached.";
  if (automation.stopMode === "HOURS" && automation.stopValue && now >= startedAt.getTime() + automation.stopValue * 3_600_000) return "Configured duration reached.";
  if (automation.stopMode === "DATETIME" && automation.stopAt && now >= automation.stopAt.getTime()) return "Configured stop time reached.";
  return null;
}

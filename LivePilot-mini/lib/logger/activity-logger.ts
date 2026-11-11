import { db } from "@/lib/db/client";
import { emitDashboardEvent } from "@/lib/events";

type LogInput = {
  automationId?: string;
  level?: "INFO" | "SUCCESS" | "WARNING" | "ERROR";
  status?: string;
  action: string;
  message: string;
  stream?: string;
  errorMessage?: string;
};

export async function activityLog(input: LogInput) {
  const log = await db.messageLog.create({ data: { ...input, level: input.level ?? "INFO" } });
  emitDashboardEvent("log.created", log);
  return log;
}

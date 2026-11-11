import { z } from "zod";
import { parseYouTubeUrl } from "@/lib/browser/youtube-chat";

export const minIntervalSeconds = Math.max(30, Number(process.env.MIN_AUTOMATION_INTERVAL_SECONDS ?? 30));

export const automationInputSchema = z.object({
  name: z.string().trim().min(2).max(100),
  youtubeUrl: z.string().trim().url().superRefine((value, ctx) => {
    try { parseYouTubeUrl(value); } catch (error) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : "Invalid YouTube URL." }); }
  }),
  googleAccountId: z.string().min(1),
  message: z.string().trim().min(1).max(200),
  intervalSeconds: z.coerce.number().int().min(minIntervalSeconds).max(86_400),
  scheduleMode: z.enum(["IMMEDIATE", "SCHEDULED"]).default("IMMEDIATE"),
  scheduledStartAt: z.string().datetime().nullable().optional(),
  stopMode: z.enum(["NONE", "MESSAGES", "MINUTES", "HOURS", "DATETIME"]).default("NONE"),
  stopValue: z.coerce.number().int().positive().max(100_000).nullable().optional(),
  stopAt: z.string().datetime().nullable().optional(),
  maxMessages: z.coerce.number().int().min(1).max(10_000),
  runUntilStopped: z.boolean().default(false),
}).refine((input) => !input.runUntilStopped || (input.stopMode === "NONE" && input.stopValue == null && input.stopAt == null), {
  message: "No limit — stop manually cannot be combined with an automatic stop condition.",
  path: ["stopMode"],
});

export const settingsSchema = z.object({
  defaultIntervalSeconds: z.coerce.number().int().min(minIntervalSeconds).max(86_400),
  maximumMessagesPerAutomation: z.coerce.number().int().min(1).max(10_000),
  browserVisible: z.literal(true),
  runBrowserMinimized: z.boolean(),
  browserExecutablePath: z.string().trim().max(500),
  dataDirectory: z.string().trim().min(1).max(500),
  desktopNotifications: z.boolean(),
  errorNotifications: z.boolean(),
});

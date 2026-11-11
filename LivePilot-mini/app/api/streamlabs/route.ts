import { z } from "zod";
import { automationController } from "@/lib/automation/automation-controller";
import { apiError } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() { return Response.json(await automationController.streamlabsLoad()); }

export async function POST(request: Request) {
  try {
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return Response.json({ error: "Expected application/json." }, { status: 415 });
    const origin = request.headers.get("origin");
    if (request.headers.get("sec-fetch-site") === "cross-site" || (origin && new URL(origin).host !== (request.headers.get("host") || new URL(request.url).host))) return Response.json({ error: "Cross-site mode changes are not allowed." }, { status: 403 });
    const configSchema = z.object({
      youtubeUrl: z.string().min(1), accountIds: z.array(z.string().min(1)).min(1), messages: z.array(z.string().min(1)).min(1),
      delaySeconds: z.number().int().min(1).max(3600), fallbackSeconds: z.number().int().min(10).max(86400), noMessageRepeats: z.boolean(),
      heistWager: z.number().int().min(1).max(1_000_000_000),
      bankAccountId: z.string().min(1).nullable(), bankPresenceMessage: z.string().min(1).max(200),
      bankPresenceSeconds: z.number().int().min(30).max(3600), protectedReserve: z.number().int().min(0).max(1_000_000_000),
      minimumTransfer: z.number().int().min(1).max(1_000_000_000), maximumTransfer: z.number().int().min(1).max(1_000_000_000),
      responseTimeoutSeconds: z.number().int().min(10).max(120), autoConsolidate: z.boolean(),
    }).strict();
    const body = z.discriminatedUnion("action", [
      z.object({ action: z.literal("save"), config: configSchema }).strict(),
      z.object({ action: z.literal("save-url"), youtubeUrl: z.string().min(1).max(500) }).strict(),
      z.object({ action: z.literal("start"), config: configSchema.optional() }).strict(),
      z.object({ action: z.literal("pause") }).strict(),
      z.object({ action: z.literal("stop") }).strict(),
    ]).parse(await request.json());
    if (body.action === "save") return Response.json(await automationController.streamlabsConfigure(body.config));
    if (body.action === "save-url") return Response.json(await automationController.streamlabsUpdateYouTubeUrl(body.youtubeUrl));
    if (body.action === "start") return Response.json(await automationController.streamlabsStart(body.config));
    if (body.action === "pause") return Response.json(await automationController.streamlabsPause());
    return Response.json(await automationController.streamlabsStop());
  } catch (error) { return apiError(error, "Could not change Streamlabs mode."); }
}

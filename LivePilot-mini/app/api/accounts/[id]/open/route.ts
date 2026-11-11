import { browserManager } from "@/lib/browser/browser-manager";
import { apiError } from "@/lib/api";
import { db } from "@/lib/db/client";

export const runtime = "nodejs";
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const account = await db.googleAccount.findUniqueOrThrow({ where: { id } });
    if (body.reconnect || account.status !== "CONNECTED") {
      await browserManager.openManualSignIn(id);
      await db.googleAccount.update({ where: { id }, data: { status: "CONNECTING" } });
    } else {
      await browserManager.openAccountSession(id, "https://www.youtube.com/");
    }
    return Response.json({ ok: true });
  }
  catch (error) { return apiError(error, "Could not open this browser session."); }
}

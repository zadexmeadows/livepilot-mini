import path from "node:path";
import fs from "node:fs/promises";
import { db } from "@/lib/db/client";
import { browserManager } from "@/lib/browser/browser-manager";
import { disconnectGoogleAccount } from "@/lib/browser/account-manager";
import { apiError } from "@/lib/api";
import { emitDashboardEvent } from "@/lib/events";

export const runtime = "nodejs";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const body = await request.json();
    if (body.action !== "disconnect") return Response.json({ error: "Unsupported account action." }, { status: 400 });
    return Response.json(await disconnectGoogleAccount(id));
  } catch (error) { return apiError(error); }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const account = await db.googleAccount.findUnique({ where: { id }, include: { _count: { select: { automations: true } } } });
    if (!account) return Response.json({ error: "Account not found." }, { status: 404 });
    if (account._count.automations > 0) return Response.json({ error: "Move or delete automations assigned to this account first." }, { status: 409 });
    await browserManager.closeContext(id);
    const dataDirectory = await db.appSetting.findUnique({ where: { key: "dataDirectory" } });
    const profilesRoot = path.resolve(/* turbopackIgnore: true */ dataDirectory?.value || process.env.APP_DATA_DIR || "./data", "browser-profiles");
    const target = path.resolve(/* turbopackIgnore: true */ account.profileDirectory);
    if (target !== profilesRoot && !target.startsWith(profilesRoot + path.sep)) throw new Error("Refusing to delete a profile outside the configured browser-profiles directory.");
    await db.googleAccount.delete({ where: { id } });
    await fs.rm(target, { recursive: true, force: true });
    emitDashboardEvent("account.deleted", { id });
    return Response.json({ ok: true });
  } catch (error) { return apiError(error); }
}

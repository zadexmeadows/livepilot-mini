import { db } from "@/lib/db/client";
import { connectGoogleAccount } from "@/lib/browser/account-manager";
import { apiError } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const accounts = await db.googleAccount.findMany({ include: { _count: { select: { automations: true } } }, orderBy: { createdAt: "desc" } });
  return Response.json(accounts);
}

export async function POST() {
  try { return Response.json(await connectGoogleAccount(), { status: 201 }); }
  catch (error) { return apiError(error, "Could not open the Google sign-in browser."); }
}

import { checkGoogleAccount } from "@/lib/browser/account-manager";
import { apiError } from "@/lib/api";

export const runtime = "nodejs";
export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try { const { id } = await params; return Response.json(await checkGoogleAccount(id)); }
  catch (error) { return apiError(error, "Could not confirm the signed-in account."); }
}

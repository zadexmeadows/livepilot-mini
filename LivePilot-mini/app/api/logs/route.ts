import { db } from "@/lib/db/client";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const level = searchParams.get("level");
  const take = Math.min(500, Math.max(1, Number(searchParams.get("take") ?? 100)));
  const logs = await db.messageLog.findMany({
    where: level && level !== "ALL" ? { level } : undefined,
    include: { automation: { select: { name: true, youtubeUrl: true } } },
    orderBy: { createdAt: "desc" }, take,
  });
  return Response.json(logs);
}

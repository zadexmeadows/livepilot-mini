import { NextResponse } from "next/server";
import { ZodError } from "zod";

export function apiError(error: unknown, fallback = "Request failed.", status = 500) {
  if (error instanceof ZodError) return NextResponse.json({ error: error.issues[0]?.message ?? "Invalid request." }, { status: 400 });
  const message = error instanceof Error ? error.message : fallback;
  return NextResponse.json({ error: message }, { status });
}

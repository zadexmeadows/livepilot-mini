import { EventEmitter } from "node:events";

export type DashboardEvent = { type: string; payload?: unknown; timestamp: string };
const globalEvents = globalThis as unknown as { dashboardEvents?: EventEmitter };
export const dashboardEvents = globalEvents.dashboardEvents ?? new EventEmitter();
dashboardEvents.setMaxListeners(100);
if (!globalEvents.dashboardEvents) globalEvents.dashboardEvents = dashboardEvents;

export function emitDashboardEvent(type: string, payload?: unknown) {
  dashboardEvents.emit("event", { type, payload, timestamp: new Date().toISOString() } satisfies DashboardEvent);
}

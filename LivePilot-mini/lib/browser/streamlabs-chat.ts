import type { Page } from "playwright";
import { findLiveChatFrame } from "./youtube-chat";
import { youtubeSelectors } from "./selectors";
import type { ChatAnnouncement } from "@/lib/automation/streamlabs-matcher";

export async function readStreamlabsChat(page: Page): Promise<ChatAnnouncement[] | null> {
  const root = await findLiveChatFrame(page);
  if (!root) return null;
  // Read only rendered chat rows through the normal website. No internal APIs.
  return root.locator(youtubeSelectors.chatMessages).evaluateAll((rows, selectors) => rows.slice(-500).map(row => ({
    id: row.id,
    author: row.querySelector(selectors.author)?.textContent?.trim() ?? "",
    text: row.querySelector(selectors.body)?.textContent?.trim() ?? "",
  })), { author: youtubeSelectors.chatMessageAuthor, body: youtubeSelectors.chatMessageBody });
}

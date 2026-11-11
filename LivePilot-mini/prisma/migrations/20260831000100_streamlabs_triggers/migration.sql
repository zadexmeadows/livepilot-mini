CREATE TABLE "StreamlabsTrigger" (
    "videoId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("videoId", "messageId")
);

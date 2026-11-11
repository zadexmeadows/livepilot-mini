CREATE TABLE "GoogleAccount" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "displayName" TEXT NOT NULL DEFAULT 'Connecting account…',
  "email" TEXT,
  "channelName" TEXT,
  "avatarUrl" TEXT,
  "profileDirectory" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'CONNECTING',
  "connectedAt" DATETIME,
  "lastUsedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "GoogleAccount_profileDirectory_key" ON "GoogleAccount"("profileDirectory");
CREATE INDEX "GoogleAccount_status_idx" ON "GoogleAccount"("status");

CREATE TABLE "Automation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "youtubeUrl" TEXT NOT NULL,
  "videoId" TEXT NOT NULL,
  "streamTitle" TEXT,
  "channelName" TEXT,
  "message" TEXT NOT NULL,
  "intervalSeconds" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "scheduleMode" TEXT NOT NULL DEFAULT 'IMMEDIATE',
  "scheduledStartAt" DATETIME,
  "stopMode" TEXT NOT NULL DEFAULT 'NONE',
  "stopValue" INTEGER,
  "stopAt" DATETIME,
  "maxMessages" INTEGER NOT NULL DEFAULT 100,
  "messagesSent" INTEGER NOT NULL DEFAULT 0,
  "sessionMessagesSent" INTEGER NOT NULL DEFAULT 0,
  "lastSentAt" DATETIME,
  "nextSendAt" DATETIME,
  "lastError" TEXT,
  "googleAccountId" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "Automation_googleAccountId_fkey" FOREIGN KEY ("googleAccountId") REFERENCES "GoogleAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "Automation_googleAccountId_idx" ON "Automation"("googleAccountId");
CREATE INDEX "Automation_status_idx" ON "Automation"("status");
CREATE INDEX "Automation_nextSendAt_idx" ON "Automation"("nextSendAt");

CREATE TABLE "AutomationExecution" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "automationId" TEXT NOT NULL,
  "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endedAt" DATETIME,
  "status" TEXT NOT NULL DEFAULT 'STARTING',
  "messagesSent" INTEGER NOT NULL DEFAULT 0,
  "errorCount" INTEGER NOT NULL DEFAULT 0,
  "completionNote" TEXT,
  CONSTRAINT "AutomationExecution_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "AutomationExecution_automationId_startedAt_idx" ON "AutomationExecution"("automationId", "startedAt");

CREATE TABLE "MessageLog" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "automationId" TEXT,
  "level" TEXT NOT NULL DEFAULT 'INFO',
  "status" TEXT,
  "action" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "stream" TEXT,
  "errorMessage" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MessageLog_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "MessageLog_createdAt_idx" ON "MessageLog"("createdAt");
CREATE INDEX "MessageLog_level_createdAt_idx" ON "MessageLog"("level", "createdAt");
CREATE INDEX "MessageLog_automationId_createdAt_idx" ON "MessageLog"("automationId", "createdAt");

CREATE TABLE "AppSetting" (
  "key" TEXT NOT NULL PRIMARY KEY,
  "value" TEXT NOT NULL,
  "updatedAt" DATETIME NOT NULL
);

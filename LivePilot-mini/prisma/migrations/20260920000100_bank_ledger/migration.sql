CREATE TABLE BankAccount (
 id TEXT PRIMARY KEY, profileId TEXT NOT NULL, economy TEXT NOT NULL, name TEXT NOT NULL, handle TEXT NOT NULL,
 balance INTEGER NOT NULL DEFAULT 0 CHECK(balance >= 0 AND balance <= 9000000000000), known INTEGER NOT NULL DEFAULT 0,
 frozen INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 0, verifiedBalance INTEGER, verifiedAt TEXT,
 createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, UNIQUE(economy,profileId)
);
CREATE TABLE BankEntry (
 id INTEGER PRIMARY KEY AUTOINCREMENT, eventKey TEXT NOT NULL UNIQUE, accountId TEXT NOT NULL REFERENCES BankAccount(id),
 amount INTEGER NOT NULL, beforeBalance INTEGER NOT NULL, afterBalance INTEGER NOT NULL,
 type TEXT NOT NULL, source TEXT NOT NULL, reference TEXT, stream TEXT, reason TEXT NOT NULL, actor TEXT NOT NULL,
 reversalOf INTEGER UNIQUE REFERENCES BankEntry(id), createdAt TEXT NOT NULL,
 CHECK(afterBalance = beforeBalance + amount), CHECK(afterBalance >= 0)
);
CREATE INDEX BankEntry_account_time ON BankEntry(accountId,id);
CREATE INDEX BankEntry_type_time ON BankEntry(type,createdAt);
CREATE INDEX BankEntry_reference ON BankEntry(reference);
CREATE INDEX BankEntry_stream ON BankEntry(stream,createdAt);
CREATE TABLE BankVerification (
 id TEXT PRIMARY KEY, accountId TEXT NOT NULL REFERENCES BankAccount(id), eventKey TEXT NOT NULL UNIQUE,
 beforeBalance INTEGER NOT NULL, externalBalance INTEGER NOT NULL, difference INTEGER NOT NULL, source TEXT NOT NULL, createdAt TEXT NOT NULL
);
CREATE TABLE BankTransfer (
 id TEXT PRIMARY KEY, requestKey TEXT NOT NULL UNIQUE, sender TEXT NOT NULL REFERENCES BankAccount(id), receiver TEXT NOT NULL REFERENCES BankAccount(id),
 amount INTEGER NOT NULL CHECK(amount > 0), kind TEXT NOT NULL, status TEXT NOT NULL, command TEXT NOT NULL,
 sourceMessageId TEXT UNIQUE, reason TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, CHECK(sender <> receiver)
);
CREATE INDEX BankTransfer_status ON BankTransfer(status,createdAt);
CREATE TABLE BankRound (
 id TEXT PRIMARY KEY, economy TEXT NOT NULL, stream TEXT NOT NULL, announcementId TEXT NOT NULL,
 resultId TEXT UNIQUE, status TEXT NOT NULL, raw TEXT NOT NULL DEFAULT '{}', reason TEXT,
 totalBefore INTEGER, gains INTEGER, losses INTEGER, totalAfter INTEGER,
 createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, UNIQUE(stream,announcementId)
);
CREATE INDEX BankRound_status_time ON BankRound(status,createdAt);
CREATE TABLE BankParticipant (
 roundId TEXT NOT NULL REFERENCES BankRound(id), accountId TEXT NOT NULL REFERENCES BankAccount(id),
 stake INTEGER, payout INTEGER, beforeBalance INTEGER, afterBalance INTEGER, version INTEGER NOT NULL,
 outcome TEXT, PRIMARY KEY(roundId,accountId)
);
CREATE TABLE BankAudit (
 id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, actor TEXT NOT NULL, reference TEXT, reason TEXT NOT NULL, metadata TEXT NOT NULL, createdAt TEXT NOT NULL
);
CREATE TABLE BankJob (
 id TEXT PRIMARY KEY, requestKey TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL,
 detail TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
);
CREATE UNIQUE INDEX BankJob_one_running ON BankJob(status) WHERE status = 'RUNNING';
CREATE TABLE BankMeta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

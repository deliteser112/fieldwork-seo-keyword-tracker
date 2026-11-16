-- CreateTable
CREATE TABLE "Page" (
    "id" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "ruleVersion" TEXT NOT NULL,
    "crawledAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Page_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Keyword" (
    "id" UUID NOT NULL,
    "pageId" UUID NOT NULL,
    "term" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "evidence" TEXT NOT NULL,

    CONSTRAINT "Keyword_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeoIssue" (
    "id" UUID NOT NULL,
    "pageId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "advisory" BOOLEAN NOT NULL,
    "evidence" TEXT NOT NULL,

    CONSTRAINT "SeoIssue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RankSnapshot" (
    "keywordId" UUID NOT NULL,
    "capturedAt" TIMESTAMPTZ(3) NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "RankSnapshot_pkey" PRIMARY KEY ("keywordId","capturedAt")
);

-- CreateTable
CREATE TABLE "CrawlJob" (
    "id" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'queued',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "claimToken" UUID,
    "leaseUntil" TIMESTAMPTZ(3),
    "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "error" TEXT,
    "retryable" BOOLEAN NOT NULL DEFAULT false,
    "selectionComplete" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CrawlJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrawlPage" (
    "id" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "sourceSitemap" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "retryable" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "CrawlPage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Page_clientId_id_idx" ON "Page"("clientId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Page_clientId_url_key" ON "Page"("clientId", "url");

-- CreateIndex
CREATE INDEX "Keyword_term_idx" ON "Keyword"("term");

-- CreateIndex
CREATE UNIQUE INDEX "Keyword_pageId_term_key" ON "Keyword"("pageId", "term");

-- CreateIndex
CREATE UNIQUE INDEX "SeoIssue_pageId_code_key" ON "SeoIssue"("pageId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "CrawlJob_clientId_key" ON "CrawlJob"("clientId");

-- CreateIndex
CREATE INDEX "CrawlJob_state_availableAt_idx" ON "CrawlJob"("state", "availableAt");

-- CreateIndex
CREATE UNIQUE INDEX "CrawlPage_jobId_ordinal_key" ON "CrawlPage"("jobId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "CrawlPage_jobId_url_key" ON "CrawlPage"("jobId", "url");

-- AddForeignKey
ALTER TABLE "Page" ADD CONSTRAINT "Page_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Keyword" ADD CONSTRAINT "Keyword_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "Page"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeoIssue" ADD CONSTRAINT "SeoIssue_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "Page"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RankSnapshot" ADD CONSTRAINT "RankSnapshot_keywordId_fkey" FOREIGN KEY ("keywordId") REFERENCES "Keyword"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrawlJob" ADD CONSTRAINT "CrawlJob_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrawlPage" ADD CONSTRAINT "CrawlPage_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "CrawlJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RankSnapshot" ADD CONSTRAINT "positive_position" CHECK (position > 0);
ALTER TABLE "CrawlJob" ADD CONSTRAINT "valid_job_state" CHECK (state IN ('queued','running','succeeded','partial','failed'));
ALTER TABLE "CrawlPage" ADD CONSTRAINT "valid_checkpoint_state" CHECK (state IN ('pending','succeeded','failed'));

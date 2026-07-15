import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { replyToComments } from "../src/lib/reply-flow.mjs";
import { extractCommentSnapshot } from "../src/lib/comment-snapshot.mjs";
import {
  backfillReplyLedgerEvents,
  getReplyLedgerEntry,
  recordReplyLedgerEvent,
  reserveReplyLedgerAttempt
} from "../src/lib/reply-ledger.mjs";

function buildCommentHtml({ replyThreadText = "", includeSendButton = false } = {}) {
  return `
    <main style="height: 600px; overflow-y: auto">
      <section>
        <div class="username-test">测试用户</div>
        <div class="time-test">07月15日 12:00</div>
        <div class="comment-content-text-test">这是一条测试评论</div>
        <div class="operations-test">
          <div>回复</div>
          ${replyThreadText ? `<div>${replyThreadText}</div>` : ""}
          ${includeSendButton ? '<div id="send-test">发送</div>' : ""}
        </div>
        <div contenteditable="true"></div>
      </section>
    </main>
  `;
}

function buildReplyOptions() {
  return {
    skipUnrepliedFilter: true,
    selectedWork: { title: "测试作品" },
    replyLedgerPath: path.join(os.tmpdir(), `douyin-reply-ledger-${randomUUID()}.jsonl`),
    replyPlans: [
      {
        id: 1,
        username: "测试用户",
        commentText: "这是一条测试评论",
        publishText: "",
        replyMessage: "测试回复"
      }
    ],
    replyLimit: 1,
    replyDryRun: true,
    replyTimeoutMs: 1000,
    replySettleMs: 10,
    replyTypeDelayMs: 0,
    timeoutMs: 5000,
    idleMs: 100,
    uiTimeoutMs: 1000
  };
}

test("页面已有回复时跳过，且不占用回复额度", async () => {
  const browser = await chromium.launch({ headless: true });

  try {
    const repliedPage = await browser.newPage();
    await repliedPage.setContent(buildCommentHtml({ replyThreadText: "查看2条回复" }));

    const repliedSnapshot = await extractCommentSnapshot(repliedPage);
    assert.equal(repliedSnapshot[0].hasReplies, true);
    assert.equal(repliedSnapshot[0].replyCount, 2);

    const skippedSummary = await replyToComments(repliedPage, buildReplyOptions());

    assert.equal(skippedSummary.exitReason, "all_reply_plans_resolved");
    assert.equal(skippedSummary.repliedCount, 0);
    assert.equal(skippedSummary.actedCount, 0);
    assert.equal(skippedSummary.skippedAlreadyRepliedCount, 1);
    assert.equal(skippedSummary.results[0].status, "skipped_already_replied");
    assert.equal(skippedSummary.results[0].appliedReplyMessage, "");
    assert.deepEqual(skippedSummary.results[0].pageReplyEvidence, {
      toggleText: "查看2条回复",
      replyCount: 2
    });
    assert.equal(
      await repliedPage.locator('[contenteditable="true"]').textContent(),
      "",
      "跳过时不应点击回复或输入文本"
    );

    const unrepliedPage = await browser.newPage();
    await unrepliedPage.setContent(buildCommentHtml());

    const unrepliedSnapshot = await extractCommentSnapshot(unrepliedPage);
    assert.equal(unrepliedSnapshot[0].hasReplies, false);
    assert.equal(unrepliedSnapshot[0].replyCount, 0);

    const dryRunSummary = await replyToComments(unrepliedPage, buildReplyOptions());

    assert.equal(dryRunSummary.actedCount, 1);
    assert.equal(dryRunSummary.skippedAlreadyRepliedCount, 0);
    assert.equal(dryRunSummary.results[0].status, "dry_run_typed");
    assert.equal(await unrepliedPage.locator('[contenteditable="true"]').textContent(), "测试回复");
  } finally {
    await browser.close();
  }
});

test("独立回复台账有记录时，即使页面无回复标记也跳过", async () => {
  const browser = await chromium.launch({ headless: true });
  const options = buildReplyOptions();
  recordReplyLedgerEvent(
    {
      workTitle: options.selectedWork.title,
      username: "测试用户",
      commentText: "这是一条测试评论",
      replyMessage: "历史回复",
      status: "db_backfill",
      source: "test"
    },
    options
  );

  try {
    const page = await browser.newPage();
    await page.setContent(buildCommentHtml());
    const summary = await replyToComments(page, options);

    assert.equal(summary.results[0].status, "skipped_reply_ledger");
    assert.equal(summary.skippedByLedgerCount, 1);
    assert.equal(summary.actedCount, 0);
    assert.equal(await page.locator('[contenteditable="true"]').textContent(), "");
  } finally {
    await browser.close();
  }
});

test("发送后必须取得页面证据，未确认时也不自动重试", async () => {
  const browser = await chromium.launch({ headless: true });

  try {
    const confirmedPage = await browser.newPage();
    await confirmedPage.setContent(buildCommentHtml({ includeSendButton: true }));
    await confirmedPage.locator("#send-test").evaluate((sendButton) => {
      sendButton.addEventListener("click", () => {
        const replyThread = document.createElement("div");
        replyThread.textContent = "查看1条回复";
        sendButton.parentElement?.append(replyThread);
      });
    });

    const confirmedOptions = {
      ...buildReplyOptions(),
      replyDryRun: false
    };
    const confirmedSummary = await replyToComments(confirmedPage, confirmedOptions);

    assert.equal(confirmedSummary.results[0].status, "replied");
    assert.equal(confirmedSummary.repliedCount, 1);
    assert.equal(confirmedSummary.results[0].replyConfirmation.confirmedBy, "reply_thread_visible");
    assert.equal(
      getReplyLedgerEntry("测试作品", "测试用户", "这是一条测试评论", confirmedOptions)?.status,
      "replied"
    );

    const unconfirmedPage = await browser.newPage();
    await unconfirmedPage.setContent(buildCommentHtml({ includeSendButton: true }));
    await unconfirmedPage.locator("#send-test").evaluate((sendButton) => {
      window.__sendClickCount = 0;
      sendButton.addEventListener("click", () => {
        window.__sendClickCount += 1;
      });
    });

    const unconfirmedOptions = {
      ...buildReplyOptions(),
      replyDryRun: false,
      replyTimeoutMs: 250
    };
    const unconfirmedSummary = await replyToComments(unconfirmedPage, unconfirmedOptions);

    assert.equal(unconfirmedSummary.results[0].status, "sent_unconfirmed");
    assert.equal(unconfirmedSummary.sentUnconfirmedCount, 1);
    assert.equal(unconfirmedSummary.unmatchedPlanCount, 0);
    assert.equal(await unconfirmedPage.evaluate(() => window.__sendClickCount), 1);
    assert.equal(
      getReplyLedgerEntry("测试作品", "测试用户", "这是一条测试评论", unconfirmedOptions)?.status,
      "sent_unconfirmed"
    );
  } finally {
    await browser.close();
  }
});

test("数据库历史回填可重复执行且不会重复追加", () => {
  const options = buildReplyOptions();
  const events = [
    {
      workTitle: "测试作品",
      username: "测试用户",
      commentText: "这是一条测试评论",
      replyMessage: "历史回复",
      status: "db_backfill",
      source: "test"
    }
  ];

  assert.deepEqual(backfillReplyLedgerEvents(events, options), {
    appendedCount: 1,
    existingCount: 0
  });
  assert.deepEqual(backfillReplyLedgerEvents(events, options), {
    appendedCount: 0,
    existingCount: 1
  });
});

test("同一评论只能取得一次发送占位", () => {
  const options = buildReplyOptions();
  const event = {
    workTitle: "测试作品",
    username: "测试用户",
    commentText: "这是一条测试评论",
    replyMessage: "测试回复"
  };

  assert.equal(reserveReplyLedgerAttempt(event, options).reserved, true);
  const duplicate = reserveReplyLedgerAttempt(event, options);
  assert.equal(duplicate.reserved, false);
  assert.equal(duplicate.reason, "existing_entry");
  assert.equal(duplicate.existingEntry.status, "send_attempted");
});

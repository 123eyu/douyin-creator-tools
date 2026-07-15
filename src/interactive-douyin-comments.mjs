#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { createSharedCliArgs, consumeSharedCliArg } from "./cli-options.mjs";
import { DEFAULT_INTERACTIVE_OUTPUT_PATH, interactiveComments } from "./comment-workflow.mjs";
import { normalizeText, toPositiveInteger } from "./lib/common.mjs";
import {
  createProtocolEvent,
  INTERACTIVE_MODES,
  MAX_INTERACTIVE_REPLY_CHARS,
  normalizeInteractiveDecision
} from "./lib/interactive-comment-protocol.mjs";

const DEFAULT_DECISION_TIMEOUT_SECONDS = 600;

function printHelp() {
  console.log(`
Usage:
  npm run comments:interactive -- "作品短标题"
  npm run comments:interactive -- [options] "作品短标题"

JSONL protocol:
  stdout emits one JSON event per line; diagnostics are written to stderr.
  For every comment_found event, write one JSON decision plus a newline to stdin:
  {"requestId":"...","action":"reply","replyMessage":"...","reason":"..."}
  {"requestId":"...","action":"skip","reason":"...","remember":false}
  {"action":"stop","reason":"..."}

Options:
  --mode <name>               smart | quality | save-token (default: smart)
  --limit <n>                 Max comments sent for model decisions (default: 20)
  --decision-timeout <sec>    Max wait for each decision (default: 600)
  --preview                    Generate decisions without typing or sending replies
  --no-history                 Do not attach this user's prior comments
  --skip-unreplied-filter      Scan all comments; page/ledger checks still apply
  --work-publish-text <text>   Disambiguate works with similar titles
  --out <path>                 Checkpoint/result JSON path
  --profile <path>             Playwright profile path
  --timeout <ms>               Max total runtime
  --headless                   Run Chromium in headless mode (visible by default)
  --debug                      Print debug logs to stderr
  --help                       Print this help
  `);
}

function parseArgs(argv) {
  const args = {
    ...createSharedCliArgs(),
    workTitle: "",
    workPublishText: "",
    mode: "smart",
    limit: 20,
    decisionTimeoutMs: DEFAULT_DECISION_TIMEOUT_SECONDS * 1000,
    preview: false,
    noHistory: false,
    skipUnrepliedFilter: false,
    outputPath: DEFAULT_INTERACTIVE_OUTPUT_PATH
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const nextIndex = consumeSharedCliArg(args, argv, index);
    if (nextIndex !== null) {
      index = nextIndex;
      continue;
    }

    switch (arg) {
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--mode": {
        const mode = normalizeText(argv[index + 1] ?? "").toLowerCase();
        if (!INTERACTIVE_MODES.has(mode)) {
          throw new Error(`--mode expects smart, quality, or save-token; received: ${mode}`);
        }
        args.mode = mode;
        index += 1;
        break;
      }
      case "--limit":
        args.limit = toPositiveInteger(argv[index + 1], "--limit");
        index += 1;
        break;
      case "--decision-timeout":
        args.decisionTimeoutMs = toPositiveInteger(argv[index + 1], "--decision-timeout") * 1000;
        index += 1;
        break;
      case "--preview":
      case "--dry-run":
        args.preview = true;
        break;
      case "--no-history":
        args.noHistory = true;
        break;
      case "--skip-unreplied-filter":
        args.skipUnrepliedFilter = true;
        break;
      case "--work-publish-text":
        args.workPublishText = normalizeText(argv[index + 1] ?? "");
        index += 1;
        break;
      case "--out":
        args.outputPath = path.resolve(argv[index + 1] ?? DEFAULT_INTERACTIVE_OUTPUT_PATH);
        index += 1;
        break;
      default:
        if (!arg.startsWith("-") && !args.workTitle) {
          args.workTitle = normalizeText(arg);
          break;
        }
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function compactSummary(summary) {
  const counts = { ...summary };
  delete counts.results;
  return counts;
}

function emitProtocol(type, payload = {}) {
  process.stdout.write(`${JSON.stringify(createProtocolEvent(type, payload))}\n`);
}

function createDecisionReceiver(lineIterator, timeoutMs) {
  return async (request) => {
    emitProtocol("comment_found", {
      requestId: request.requestId,
      sequence: request.sequence,
      selectedWork: request.selectedWork,
      routing: request.routing,
      comment: request.comment,
      decisionSchema: {
        reply: {
          requestId: request.requestId,
          action: "reply",
          replyMessage: `required; at most ${MAX_INTERACTIVE_REPLY_CHARS} Unicode characters`,
          reason: "optional"
        },
        skip: {
          requestId: request.requestId,
          action: "skip",
          reason: "optional",
          remember: "optional boolean; true permanently skips this comment"
        },
        stop: {
          action: "stop",
          reason: "optional"
        }
      }
    });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const remainingMs = Math.max(1, deadline - Date.now());
      let timer;
      const lineResult = await Promise.race([
        lineIterator.next(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Decision timed out after ${timeoutMs}ms.`)),
            remainingMs
          );
        })
      ]).finally(() => clearTimeout(timer));

      if (lineResult.done) {
        return {
          action: "stop",
          reason: "stdin_closed"
        };
      }

      const line = String(lineResult.value ?? "").trim();
      if (!line) {
        continue;
      }

      try {
        return normalizeInteractiveDecision(line, request.requestId);
      } catch (error) {
        emitProtocol("decision_rejected", {
          requestId: request.requestId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    throw new Error(`Decision timed out after ${timeoutMs}ms.`);
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (!args.workTitle) {
    throw new Error('Missing work title. Usage: npm run comments:interactive -- "作品短标题"');
  }

  // stdout 保持为机器可解析的 JSONL；浏览器与数据库诊断统一写到 stderr。
  console.log = (...values) => console.error(...values);
  const lines = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
    terminal: false
  });

  try {
    const result = await interactiveComments({
      ...args,
      requestDecision: createDecisionReceiver(
        lines[Symbol.asyncIterator](),
        args.decisionTimeoutMs
      ),
      onReady: ({ selectedWork, outputPath }) => {
        emitProtocol("ready", {
          selectedWork,
          outputPath,
          mode: args.mode,
          preview: args.preview,
          decisionLimit: args.limit
        });
      },
      onProgress: ({ latestResult, summary }) => {
        emitProtocol("result", {
          requestId: latestResult.requestId,
          result: latestResult,
          summary: compactSummary(summary)
        });
      }
    });

    emitProtocol("complete", {
      outputPath: result.outputPath,
      selectedWork: result.selectedWork,
      summary: compactSummary(result)
    });
  } finally {
    lines.close();
  }
}

main().catch((error) => {
  emitProtocol("fatal", {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exitCode = 1;
});

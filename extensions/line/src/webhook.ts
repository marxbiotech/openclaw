import type { webhook } from "@line/bot-sdk";
import type { NextFunction, Request, Response } from "express";
import { danger, logVerbose, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { parseLineWebhookBody, validateLineSignature } from "./webhook-utils.js";

const LINE_WEBHOOK_MAX_RAW_BODY_BYTES = 64 * 1024;

export interface LineWebhookOptions {
  channelSecret: string;
  onEvents: (body: webhook.CallbackRequest) => Promise<void>;
  runtime?: RuntimeEnv;
}

function readRawBody(req: Request): string | null {
  const rawBody =
    (req as { rawBody?: string | Buffer }).rawBody ??
    (typeof req.body === "string" || Buffer.isBuffer(req.body) ? req.body : null);
  if (!rawBody) {
    return null;
  }
  return Buffer.isBuffer(rawBody) ? rawBody.toString("utf-8") : rawBody;
}

function parseWebhookBody(rawBody?: string | null): webhook.CallbackRequest | null {
  if (!rawBody) {
    return null;
  }
  return parseLineWebhookBody(rawBody);
}

export function createLineWebhookMiddleware(
  options: LineWebhookOptions,
): (req: Request, res: Response, _next: NextFunction) => Promise<void> {
  const { channelSecret, onEvents, runtime } = options;

  const logError = (err: unknown, prefix: string) => {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    const fn = runtime?.error ?? console.error;
    fn(danger(`${prefix}: ${detail}`));
  };

  return async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
    try {
      const signature = req.headers["x-line-signature"];

      if (!signature || typeof signature !== "string") {
        res.status(400).json({ error: "Missing X-Line-Signature header" });
        return;
      }

      const rawBody = readRawBody(req);

      if (!rawBody) {
        res.status(400).json({ error: "Missing raw request body for signature verification" });
        return;
      }
      if (Buffer.byteLength(rawBody, "utf-8") > LINE_WEBHOOK_MAX_RAW_BODY_BYTES) {
        res.status(413).json({ error: "Payload too large" });
        return;
      }

      if (!validateLineSignature(rawBody, signature, channelSecret)) {
        logVerbose("line: webhook signature validation failed");
        res.status(401).json({ error: "Invalid signature" });
        return;
      }

      const body = parseWebhookBody(rawBody);

      if (!body) {
        res.status(400).json({ error: "Invalid webhook payload" });
        return;
      }

      res.status(200).json({ status: "ok" });

      if (body.events && body.events.length > 0) {
        logVerbose(`line: received ${body.events.length} webhook events`);
        void Promise.resolve()
          .then(() => onEvents(body))
          .catch((err: unknown) => logError(err, "line webhook background processing error"));
      }
    } catch (err) {
      logError(err, "line webhook error");
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  };
}

export interface StartLineWebhookOptions {
  channelSecret: string;
  onEvents: (body: webhook.CallbackRequest) => Promise<void>;
  runtime?: RuntimeEnv;
  path?: string;
}

export function startLineWebhook(options: StartLineWebhookOptions): {
  path: string;
  handler: (req: Request, res: Response, _next: NextFunction) => Promise<void>;
} {
  const channelSecret =
    typeof options.channelSecret === "string" ? options.channelSecret.trim() : "";
  if (!channelSecret) {
    throw new Error(
      "LINE webhook mode requires a non-empty channel secret. " +
        "Set channels.line.channelSecret in your config.",
    );
  }
  const path = options.path ?? "/line/webhook";
  const middleware = createLineWebhookMiddleware({
    channelSecret,
    onEvents: options.onEvents,
    runtime: options.runtime,
  });

  return { path, handler: middleware };
}

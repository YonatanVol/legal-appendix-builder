'use strict';

const { session } = require('electron');
const Anthropic = require('@anthropic-ai/sdk');

const settings = require('../settings');
const { lockDownAi, AI_PARTITION } = require('../security');

/*
 * Claude, for Summarize and Translate.
 *
 * Every request goes through a session of its own that may reach api.anthropic.com
 * and nothing else (security.js), by handing the SDK that session's fetch. A test may
 * point it at a local stand-in on the loopback address, never another machine.
 *
 * The model is Claude Opus 5.5. If it declines a request, the API's server-side fallback
 * re-runs it on another model in the same call, so a legal document about an injury is
 * not left unsummarised because a classifier was cautious.
 */
const MODEL = 'claude-opus-5-5';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

let aiSession = null;

function sessionFor() {
  if (aiSession) return aiSession;
  aiSession = session.fromPartition(AI_PARTITION);
  lockDownAi(aiSession, { testBase: process.env.OFFICE_AI_TEST_BASE });
  return aiSession;
}

async function client() {
  const apiKey = await settings.getApiKey();
  if (!apiKey) throw new Error('לא הוזן מפתח API של Claude. אפשר להזין אותו בהגדרות.');
  const ses = sessionFor();
  const base = process.env.OFFICE_AI_TEST_BASE;
  return new Anthropic({
    apiKey,
    baseURL: base || undefined,
    fetch: (url, init) => ses.fetch(String(url), init),
    maxRetries: 2,
    timeout: 10 * 60 * 1000,
  });
}

/**
 * One request, streamed so a long document cannot hit a timeout, returning the text.
 * @param {{system: string, content: Array, maxTokens?: number, effort?: string, signal?: AbortSignal}} spec
 */
async function ask({ system, content, maxTokens = 32000, effort = 'medium', signal }) {
  const c = await client();
  let message;
  try {
    const stream = c.beta.messages.stream({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      output_config: { effort },
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
      messages: [{ role: 'user', content }],
    }, { signal });
    message = await stream.finalMessage();
  } catch (err) {
    throw new Error(describe(err));
  }
  if (message.stop_reason === 'refusal') {
    throw new Error('Claude סירב לעבד את המסמך הזה. אפשר לנסות שוב, או לחלק אותו לחלקים קטנים יותר.');
  }
  const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  if (message.stop_reason === 'max_tokens') return { text, truncated: true, usage: message.usage };
  return { text, truncated: false, usage: message.usage };
}

/** A short request that proves the key works, without a document. */
async function check() {
  const c = await client();
  try {
    await c.models.retrieve(MODEL);
    return true;
  } catch (err) {
    throw new Error(describe(err));
  }
}

function describe(err) {
  if (err && (err.name === 'AbortError' || err instanceof Anthropic.APIUserAbortError)) {
    const e = new Error('הפעולה בוטלה.');
    e.cancelled = true;
    throw e;
  }
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return 'מפתח ה-API שגוי, בוטל, או שאין לו הרשאה. בדוק אותו בהגדרות.';
  if (err instanceof Anthropic.RateLimitError) return 'Anthropic מגבילה כרגע את כמות הבקשות. המתן דקה ונסה שוב.';
  if (err instanceof Anthropic.BadRequestError) {
    if (/too long|too large|maximum|exceed/i.test(err.message)) return 'המסמך גדול מדי לשליחה אחת.';
    return `Anthropic דחתה את הבקשה: ${err.message}`;
  }
  if (err instanceof Anthropic.APIConnectionError) return 'אין חיבור ל-Anthropic. בדוק את החיבור לאינטרנט ונסה שוב.';
  if (err instanceof Anthropic.InternalServerError) return 'השירות של Anthropic לא זמין כרגע. נסה שוב בעוד כמה דקות.';
  if (err instanceof Anthropic.APIError) return `שגיאה מ-Anthropic (${err.status}): ${err.message}`;
  return err && err.message ? err.message : String(err);
}

async function availability() {
  return (await settings.apiKeyHint())
    ? { available: true }
    : { available: false, reason: 'הכלי כבוי עד שיוזן מפתח API של Claude בהגדרות. הוא שולח את המסמך ל-Anthropic, ולכן הוא לא פועל בלי החלטה מפורשת.' };
}

module.exports = { ask, check, availability, MODEL, sessionFor };

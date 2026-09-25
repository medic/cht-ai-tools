'use strict';
// Horizons and expectations stated in thread notes (FR-029): deterministic parsing first, the model only
// when no date was found. Note text is untrusted and is wrapped before it reaches the model (FR-044).
const fs = require('node:fs');
const path = require('node:path');
const { z } = require('zod');
const { PACKAGE_PATHS } = require('../config/schema');
const { costRecord } = require('./review');
const { wrapUntrusted } = require('../agent/prompt-assembly');
const { maskPeople } = require('../corpus/scrub');

const DAY_MS = 86400000;

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11,
  november: 11, dec: 12, december: 12,
};
const MONTH = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?'
  + '|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const KEYWORD = '(?:until|till|through|thru|before|by|to)';
const ORDINAL = '(?:st|nd|rd|th)?';

const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/;
const END_OF_MONTH = new RegExp(`\\b${KEYWORD}\\s+(?:the\\s+)?end\\s+of\\s+(?:the\\s+)?month\\b`, 'i');
const END_OF_WEEK = new RegExp(`\\b${KEYWORD}\\s+(?:the\\s+)?end\\s+of\\s+(?:the\\s+)?week\\b`, 'i');
const DAY_MONTH = new RegExp(
  `\\b${KEYWORD}\\s+(\\d{1,2})${ORDINAL}\\s+(?:of\\s+)?${MONTH}\\b\\.?(?:,?\\s+(\\d{4}))?`, 'i'
);
const MONTH_DAY = new RegExp(`\\b${KEYWORD}\\s+${MONTH}\\b\\.?\\s+(\\d{1,2})${ORDINAL}(?:,?\\s+(\\d{4}))?`, 'i');
const NEXT_N = /\bfor\s+the\s+next\s+(\d+)\s*(day|days|week|weeks)\b/i;
const MAX_LEAD = '(?:up\\s+to|below|under|at\\s+most|no\\s+more\\s+than|less\\s+than|max(?:imum)?\\s+of)';
const EXPECTED_MAX = new RegExp(`\\b${MAX_LEAD}\\s+\\$?(\\d[\\d,]*(?:\\.\\d+)?)\\s*(k|m|%)?`, 'i');
const FACTORS = { k: 1000, m: 1000000 };

const isoOf = (date) => date.toISOString().slice(0, 10);

const utcDate = (year, month, day) => {
  const date = new Date(Date.UTC(year, month - 1, day));
  const valid = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return valid ? date : null;
};

const resolveDayMonth = (day, monthName, year, noteDate) => {
  const month = MONTHS[monthName.toLowerCase()];
  if (!month) {
    return null;
  }
  if (year) {
    const explicit = utcDate(Number(year), month, day);
    return explicit ? isoOf(explicit) : null;
  }
  const thisYear = utcDate(noteDate.getUTCFullYear(), month, day);
  if (!thisYear) {
    return null;
  }
  if (thisYear.getTime() < noteDate.getTime()) {
    const nextYear = utcDate(noteDate.getUTCFullYear() + 1, month, day);
    return nextYear ? isoOf(nextYear) : null;
  }
  return isoOf(thisYear);
};

/** Find a horizon date and an expected maximum in a note, deterministically. */
const parseHorizon = (text, { noteDate }) => {
  const source = String(text || '');
  const base = new Date(`${noteDate}T00:00:00Z`);
  let horizon = null;

  const iso = ISO_DATE.exec(source);
  if (iso) {
    const date = utcDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    horizon = date ? isoOf(date) : null;
  }
  if (!horizon && END_OF_MONTH.test(source)) {
    horizon = isoOf(new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)));
  }
  if (!horizon && END_OF_WEEK.test(source)) {
    const daysToSunday = (7 - base.getUTCDay()) % 7;
    horizon = isoOf(new Date(base.getTime() + daysToSunday * DAY_MS));
  }
  if (!horizon) {
    const dayMonth = DAY_MONTH.exec(source);
    if (dayMonth) {
      horizon = resolveDayMonth(Number(dayMonth[1]), dayMonth[2], dayMonth[3], base);
    }
  }
  if (!horizon) {
    const monthDay = MONTH_DAY.exec(source);
    if (monthDay) {
      horizon = resolveDayMonth(Number(monthDay[2]), monthDay[1], monthDay[3], base);
    }
  }
  if (!horizon) {
    const next = NEXT_N.exec(source);
    if (next) {
      const days = Number(next[1]) * (next[2].startsWith('week') ? 7 : 1);
      horizon = isoOf(new Date(base.getTime() + days * DAY_MS));
    }
  }

  let expectedMax = null;
  const max = EXPECTED_MAX.exec(source);
  if (max) {
    const number = Number(max[1].replace(/,/g, ''));
    const suffix = (max[2] || '').toLowerCase();
    const factor = FACTORS[suffix] || 1;
    expectedMax = Number.isFinite(number) ? number * factor : null;
  }
  return { horizon, expected_max: expectedMax };
};

const FEEDBACK_PARSE_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['horizon', 'expected_max', 'item_reference'],
  properties: {
    horizon: {
      type: ['string', 'null'],
      description: 'The date until which the behaviour is expected, as YYYY-MM-DD, or null.',
    },
    expected_max: { type: ['number', 'null'], description: 'The maximum value the note says to expect, or null.' },
    item_reference: {
      type: ['string', 'null'],
      description: 'The metric, host or item id the note refers to, or null.',
    },
  },
});

const ModelAnswer = z.object({
  horizon: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  expected_max: z.number().nullable(),
  item_reference: z.string().nullable(),
}).strict();

let promptCache = null;
const promptText = (definition) => {
  if (definition && typeof definition.feedbackParse === 'string') {
    return definition.feedbackParse;
  }
  if (promptCache === null) {
    promptCache = fs.readFileSync(path.join(PACKAGE_PATHS.promptsDir, 'feedback-parse.md'), 'utf8');
  }
  return promptCache;
};

/**
 * Deterministic parse first; the model only when no horizon was found and an engine is available. `earlierNotes`
 * are the earlier notes of the same item's thread (FR-085, revision 29): untrusted context the model reads the
 * note against, so "make that the 25th" resolves; the deterministic parse never needs them.
 * Returns { horizon, expected_max, item_reference, source }.
 */
const parseNoteWithModel = async ({
  text, noteDate, engine = null, model, definition = null, earlierNotes = [], runId = null,
}) => {
  const deterministic = parseHorizon(text, { noteDate });
  if (deterministic.horizon || !engine) {
    // `none`: no date in the note and no model to ask; the record says so (revision 34).
    const source = deterministic.horizon ? 'deterministic' : 'none';
    return { ...deterministic, item_reference: null, source, call: null };
  }
  // People are masked before any note reaches the model (FR-029, revision 33); the dates and figures stay.
  const earlier = earlierNotes.map((text_, i) => `${i + 1}. ${maskPeople(text_)}`).join('\n');
  const context = earlierNotes.length
    ? `Earlier notes on the same item, in thread order:\n${wrapUntrusted('earlier-notes', earlier)}\n\n`
    : '';
  const note = wrapUntrusted('slack-note', maskPeople(text));
  const userPrompt = `Note date: ${noteDate}\n\n${context}The note to read:\n${note}`;
  try {
    const turn = await engine.singleTurn({
      systemPrompt: [promptText(definition)],
      userPrompt,
      outputSchema: FEEDBACK_PARSE_SCHEMA,
      bounds: { maxTurns: 1, maxBudgetUsd: 0.05, timeoutMs: 30000 },
      model,
      effort: 'low',
      name: 'feedback-parse',
    });
    const result = (turn && turn.result) || {};
    // The call is part of the run's cost (FR-049, revision 34), whatever the answer; one record shape with the
    // review's (revision 36).
    const call = costRecord({ runId, model, result, kind: 'parse' });
    const answer = ModelAnswer.safeParse(turn && turn.structuredOutput);
    if (!answer.success) {
      return {
        horizon: null, expected_max: deterministic.expected_max, item_reference: null, source: 'model-invalid', call,
      };
    }
    return { ...answer.data, source: 'model', call };
  } catch {
    return {
      horizon: null, expected_max: deterministic.expected_max, item_reference: null, source: 'model-failed', call: null,
    };
  }
};

module.exports = { parseHorizon, parseNoteWithModel, FEEDBACK_PARSE_SCHEMA };

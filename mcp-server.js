/* ============================================================
   MCP SERVER — exposes the plan write endpoints as tools Claude can call
   mid-conversation. Deliberately thin: every tool is a small wrapper over
   plan-service.js, which is the same code the HTTP endpoints use.

   Mounted onto the existing Express app at /mcp so it rides on the one
   Render service rather than needing a second one.
   ============================================================ */

import express from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  getPlan,
  getChangeLog,
  updateSession,
  rescheduleSession,
  PlanError,
  BLOCK_START,
  RACE_DATE,
} from './plan-service.js';

const ok = (payload) => ({ content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] });

// PlanError means "you asked for something that doesn't make sense" — hand that back
// as readable text so Claude can fix the call or ask Jack, rather than as a crash.
const fail = (err) => ({
  isError: true,
  content: [
    {
      type: 'text',
      text:
        err instanceof PlanError
          ? JSON.stringify({ error: err.message, ...err.details }, null, 2)
          : `Something went wrong talking to the Stride backend: ${err.message}`,
    },
  ],
});

function buildServer(supabase) {
  const server = new McpServer(
    { name: 'stride', version: '1.0.0' },
    {
      instructions:
        `Stride is Jack's marathon training app. The plan is a 12-week block running ` +
        `${BLOCK_START} to race day on ${RACE_DATE}, targeting a sub-3:30 marathon, with a ` +
        `tune-up race on 2026-09-20 that sets the final pace target.\n\n` +
        `Before changing anything, call get_plan to see what is actually scheduled, and tell ` +
        `Jack what you are about to change. If reschedule_session comes back with ` +
        `needs_confirmation, do NOT retry with confirm: true on your own — show Jack the ` +
        `warnings and wait for him to say go ahead.`,
    }
  );

  server.registerTool(
    'get_plan',
    {
      title: 'Get planned sessions',
      description:
        'Read the training plan for a date range, including what has already been logged as ' +
        'hit/niggle/missed and any notes. Call this before writing anything so you know what ' +
        'is actually scheduled. Dates are YYYY-MM-DD. Omit both dates for the whole 12-week block.',
      inputSchema: {
        from_date: z.string().optional().describe('Start of range, YYYY-MM-DD. Inclusive.'),
        to_date: z.string().optional().describe('End of range, YYYY-MM-DD. Inclusive.'),
      },
    },
    async ({ from_date, to_date }) => {
      try {
        return ok(await getPlan(supabase, { from_date, to_date }));
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    'update_session',
    {
      title: 'Log how a session went',
      description:
        'Mark the session on a given date as hit, niggle, or missed, with optional notes. ' +
        'Use "niggle" when something hurt or felt off but the session happened. ' +
        'This also triggers the plan\'s own adaptive rules (e.g. a missed long run gets moved), ' +
        'which come back in the response — relay them to Jack.',
      inputSchema: {
        date: z.string().describe('Date of the session, YYYY-MM-DD.'),
        status: z.enum(['hit', 'niggle', 'miss']).describe('hit = done as planned, niggle = done but something hurt, miss = did not happen.'),
        notes: z.string().optional().describe('Optional free text, e.g. "left calf tight from 6km".'),
        session_type: z
          .string()
          .optional()
          .describe('Only needed to disambiguate when two sessions sit on the same date.'),
      },
    },
    async (args) => {
      try {
        return ok(await updateSession(supabase, { ...args, source: 'claude' }));
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    'reschedule_session',
    {
      title: 'Move a session or change its type',
      description:
        'Move a session to a different date, change its type (e.g. easy -> long), or both. ' +
        'IMPORTANT: if the move shifts load between weeks, crosses a training phase boundary, ' +
        'or drops hard work into a cutback or taper week, this returns needs_confirmation ' +
        'with warnings and changes nothing. Show those warnings to Jack in plain language and ' +
        'wait for him to agree before calling again with confirm: true. Never set confirm: true ' +
        'on the first call, and never set it based on your own judgement.',
      inputSchema: {
        from_date: z.string().describe('Current date of the session to move, YYYY-MM-DD.'),
        to_date: z.string().optional().describe('New date, YYYY-MM-DD. Omit to change type in place.'),
        session_type: z
          .enum(['easy', 'long', 'quality', 'strength', 'bike', 'rest', 'event'])
          .optional()
          .describe('New session type, if changing it.'),
        reason: z.string().optional().describe('Why, in a few words — stored in the change log.'),
        confirm: z
          .boolean()
          .optional()
          .describe('Only set true after Jack has seen the warnings and agreed.'),
      },
    },
    async (args) => {
      try {
        return ok(await rescheduleSession(supabase, { ...args, source: 'claude' }));
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    'get_change_log',
    {
      title: 'Recent changes',
      description:
        'List recent writes to the plan, newest first, with before/after values. Use this to ' +
        'tell Jack what was changed and when, or to work out what to put back if something ' +
        'needs reversing.',
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional().describe('How many entries. Default 50.'),
      },
    },
    async ({ limit }) => {
      try {
        return ok(await getChangeLog(supabase, { limit }));
      } catch (err) {
        return fail(err);
      }
    }
  );

  return server;
}

export function createMcpRouter(supabase, apiKey) {
  const router = express.Router();

  // The key can arrive as a normal auth header, or as the last part of the URL.
  // The URL form exists because Claude's custom-connector screen may only give you
  // a field for the server address — see SETUP.md.
  const authed = (req, res, next) => {
    if (!apiKey) {
      return res.status(503).json({ error: 'STRIDE_API_KEY is not set on the server.' });
    }
    const header = req.get('authorization') || '';
    const supplied =
      req.params.key ||
      (header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : null) ||
      req.get('x-api-key');

    if (supplied !== apiKey) {
      // Deliberately no WWW-Authenticate header here. Sending one signals to
      // MCP-spec-aware clients (including Claude's connector) that this server
      // wants OAuth, which sends them off trying to register an OAuth client
      // against endpoints that don't exist — surfaced as "Couldn't register
      // with Stride's sign-in service." This is a plain pasted-key scheme, not
      // OAuth, so a bare 401 is the correct response.
      return res.status(401).json({ error: 'Bad or missing API key.' });
    }
    next();
  };

  const handle = async (req, res) => {
    const server = buildServer(supabase);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  };

  router.post('/', authed, handle);
  router.post('/:key', authed, handle);

  // Stateless server: there's no session to stream from or tear down.
  const notAllowed = (_req, res) =>
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  router.get(['/', '/:key'], notAllowed);
  router.delete(['/', '/:key'], notAllowed);

  return router;
}

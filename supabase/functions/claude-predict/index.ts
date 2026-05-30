import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const JSON_HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type' } });
  }

  try {
    const { home_team, away_team, round } = await req.json();

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );
    const { data: keyRow } = await supabase.from('settings').select('text_value').eq('key', 'anthropic_key').single();
    const apiKey = keyRow?.text_value;
    if (!apiKey) return new Response(JSON.stringify({ error: 'No API key configured' }), { status: 500, headers: JSON_HEADERS });

    const isKO = round !== 'group';
    const roundLabel: Record<string, string> = {
      group: 'Group Stage', R32: 'Round of 32', R16: 'Round of 16',
      QF: 'Quarter-Final', SF: 'Semi-Final', final: 'Final', bronze: 'Third Place Play-off'
    };

    const jsonFormat = isKO
      ? '{"home":N,"away":N,"et_winner":"H"|"A"|null}'
      : '{"home":N,"away":N}';

    const systemPrompt = [
      'You are a football score predictor for the 2026 FIFA World Cup.',
      'You MUST end every response with a JSON prediction on its own line.',
      'The JSON must be the LAST thing in your response, with no text after it.',
      'Format: ' + jsonFormat,
      'For knockout rounds where scores are level after 90 min, set et_winner to "H" (home wins) or "A" (away wins).',
      'Use realistic scores — strong teams beat weak ones convincingly. Do not default to 1-1 draws.',
      'CRITICAL: Your response MUST end with the JSON. No exceptions.',
    ].join(' ');

    const userPrompt = [
      'Predict: ' + home_team + ' vs ' + away_team + ' (' + (roundLabel[round] ?? round) + ').',
      'Briefly consider current form, key players, and relative strength.',
      'End your response with ONLY this JSON on the last line (replace N with numbers):',
      jsonFormat,
    ].join(' ');

    // First attempt: with web search
    let pred = await callClaude(apiKey, systemPrompt, userPrompt, true);

    // If web search fails or returns no JSON, fall back without web search
    if (!pred) {
      pred = await callClaude(apiKey, systemPrompt, userPrompt, false);
    }

    // Last resort: ask Claude to just give the JSON from its own analysis
    if (!pred) {
      const extractPrompt = 'Give me a score prediction for ' + home_team + ' vs ' + away_team + ' (' + (roundLabel[round] ?? round) + '). Reply with ONLY the JSON: ' + jsonFormat;
      pred = await callClaude(apiKey, 'Reply with ONLY a JSON object, no other text.', extractPrompt, false);
    }

    if (!pred) {
      return new Response(JSON.stringify({ error: 'Could not extract a prediction. Try again.' }), { status: 500, headers: JSON_HEADERS });
    }

    return new Response(JSON.stringify(pred), { headers: JSON_HEADERS });

  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: JSON_HEADERS });
  }
});

async function callClaude(
  apiKey: string,
  system: string,
  userPrompt: string,
  useWebSearch: boolean
): Promise<{ home: number; away: number; et_winner?: string | null } | null> {
  const messages: any[] = [{ role: 'user', content: userPrompt }];
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  };
  if (useWebSearch) headers['anthropic-beta'] = 'web-search-2025-03-05';

  for (let turn = 0; turn < 8; turn++) {
    const body: any = {
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system,
      messages,
    };
    if (useWebSearch) {
      body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }];
    }

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const data = await resp.json();

    // If web search is not available on this account, signal caller to retry without it
    if (!resp.ok && useWebSearch && turn === 0) return null;
    if (!resp.ok) return null;

    const textBlocks = (data.content ?? []).filter((b: any) => b.type === 'text');
    const fullText = textBlocks.map((b: any) => b.text).join('\n');

    if (data.stop_reason === 'end_turn') {
      return extractJSON(fullText);
    }

    if (data.stop_reason === 'tool_use') {
      // Append the full assistant turn (includes tool_use blocks and any tool_result blocks
      // already filled in by the API for built-in tools like web_search)
      messages.push({ role: 'assistant', content: data.content });

      // For built-in web_search, results are already in data.content as tool_result blocks.
      // We only need to add a user turn if there are tool_use blocks WITHOUT matching tool_result blocks.
      const toolUseIds = new Set(
        (data.content ?? []).filter((b: any) => b.type === 'tool_use').map((b: any) => b.id)
      );
      const coveredIds = new Set(
        (data.content ?? []).filter((b: any) => b.type === 'tool_result').map((b: any) => b.tool_use_id)
      );
      const unhandledIds = [...toolUseIds].filter(id => !coveredIds.has(id));

      if (unhandledIds.length > 0) {
        // Non-built-in tool: provide empty results so the conversation can continue
        const toolResults = unhandledIds.map(id => ({
          type: 'tool_result',
          tool_use_id: id,
          content: 'No result available.',
        }));
        messages.push({ role: 'user', content: toolResults });
      }
      // else: built-in tool results are already in data.content, just loop again
      continue;
    }

    // Any other stop_reason — try to extract from whatever text we have
    return extractJSON(fullText);
  }

  return null;
}

function extractJSON(text: string): { home: number; away: number; et_winner?: string | null } | null {
  if (!text) return null;
  // Find all JSON-like objects and take the last one (the prediction)
  const matches = text.match(/\{[^{}]*\}/g);
  if (!matches) return null;
  for (let i = matches.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(matches[i]);
      if (typeof obj.home === 'number' && typeof obj.away === 'number') {
        return { home: obj.home, away: obj.away, et_winner: obj.et_winner ?? null };
      }
    } catch { /* skip */ }
  }
  return null;
}

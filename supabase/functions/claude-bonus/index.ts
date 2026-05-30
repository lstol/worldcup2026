import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const JSON_HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type' } });
  }

  try {
    const { question, type, options } = await req.json();
    if (!question) {
      return new Response(JSON.stringify({ error: 'No question provided' }), { status: 400, headers: JSON_HEADERS });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );
    const { data: keyRow } = await supabase.from('settings').select('text_value').eq('key', 'anthropic_key').single();
    const apiKey = keyRow?.text_value;
    if (!apiKey) return new Response(JSON.stringify({ error: 'No API key configured' }), { status: 500, headers: JSON_HEADERS });

    const opts: string[] = Array.isArray(options) ? options : [];

    // Describe the required answer format per question type
    let formatRule = '';
    if (type === 'yesno') {
      formatRule = 'The answer MUST be exactly "Yes" or "No".';
    } else if (type === 'choice') {
      formatRule = 'The answer MUST be EXACTLY one of these options (copy it verbatim): ' + opts.map(function (o) { return '"' + o + '"'; }).join(', ') + '.';
    } else if (type === 'number') {
      formatRule = 'The answer MUST be a single whole number (digits only).';
    } else {
      formatRule = 'The answer MUST be a short text answer, typically a single team name or player name. No explanation.';
    }

    const systemPrompt = [
      'You are an expert football analyst making a best-guess prediction for a 2026 FIFA World Cup bonus-question competition.',
      'You answer ONE bonus question with your single most likely guess.',
      'You MUST end every response with a JSON object on its own line, and it MUST be the LAST thing in your response with no text after it.',
      'Format: {"answer": "..."}',
      formatRule,
      'CRITICAL: Your response MUST end with the JSON. No exceptions.',
    ].join(' ');

    const userPrompt = [
      'Bonus question: ' + question,
      type === 'choice' && opts.length ? ('Allowed options: ' + opts.join(' | ') + '.') : '',
      'Briefly consider current form, squads and recent results, then commit to your single best guess.',
      'End your response with ONLY this JSON on the last line: {"answer": "your answer"}',
    ].filter(Boolean).join(' ');

    let result = await callClaude(apiKey, systemPrompt, userPrompt, true);
    if (!result) result = await callClaude(apiKey, systemPrompt, userPrompt, false);
    if (!result) {
      const extractPrompt = 'Answer this World Cup bonus question with your single best guess. ' + question + ' ' + formatRule + ' Reply with ONLY the JSON: {"answer": "..."}';
      result = await callClaude(apiKey, 'Reply with ONLY a JSON object, no other text.', extractPrompt, false);
    }
    if (!result) {
      return new Response(JSON.stringify({ error: 'Could not extract an answer. Try again.' }), { status: 500, headers: JSON_HEADERS });
    }

    let answer = result.answer;

    // Normalise per type
    if (type === 'yesno') {
      const low = String(answer).trim().toLowerCase();
      answer = low.startsWith('y') ? 'Yes' : 'No';
    } else if (type === 'number') {
      const m = String(answer).match(/-?\d+/);
      answer = m ? m[0] : String(answer).trim();
    } else if (type === 'choice' && opts.length) {
      const norm = String(answer).trim().toLowerCase();
      const exact = opts.find(function (o) { return o.toLowerCase() === norm; });
      const partial = opts.find(function (o) { return o.toLowerCase().indexOf(norm) >= 0 || norm.indexOf(o.toLowerCase()) >= 0; });
      answer = exact || partial || opts[0];
    } else {
      answer = String(answer).trim();
    }

    return new Response(JSON.stringify({ answer: answer }), { headers: JSON_HEADERS });

  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: JSON_HEADERS });
  }
});

async function callClaude(
  apiKey: string,
  system: string,
  userPrompt: string,
  useWebSearch: boolean
): Promise<{ answer: string } | null> {
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

    if (!resp.ok && useWebSearch && turn === 0) return null;
    if (!resp.ok) return null;

    const textBlocks = (data.content ?? []).filter((b: any) => b.type === 'text');
    const fullText = textBlocks.map((b: any) => b.text).join('\n');

    if (data.stop_reason === 'end_turn') {
      return extractJSON(fullText);
    }

    if (data.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: data.content });
      const toolUseIds = new Set(
        (data.content ?? []).filter((b: any) => b.type === 'tool_use').map((b: any) => b.id)
      );
      const coveredIds = new Set(
        (data.content ?? []).filter((b: any) => b.type === 'tool_result').map((b: any) => b.tool_use_id)
      );
      const unhandledIds = [...toolUseIds].filter(id => !coveredIds.has(id));
      if (unhandledIds.length > 0) {
        const toolResults = unhandledIds.map(id => ({
          type: 'tool_result',
          tool_use_id: id,
          content: 'No result available.',
        }));
        messages.push({ role: 'user', content: toolResults });
      }
      continue;
    }

    return extractJSON(fullText);
  }

  return null;
}

function extractJSON(text: string): { answer: string } | null {
  if (!text) return null;
  const matches = text.match(/\{[^{}]*\}/g);
  if (!matches) return null;
  for (let i = matches.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(matches[i]);
      if (obj.answer != null && obj.answer !== '') {
        return { answer: String(obj.answer) };
      }
    } catch { /* skip */ }
  }
  return null;
}

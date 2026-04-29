exports.handler = async function(event, context) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'API key not configured on server.' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch(e) { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body.' }) }; }

  const { story, targetLanguage } = body;

  if (!story || !targetLanguage) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing story or target language.' }) };
  }

  const system = `You are a professional translator specializing in children's literature. Translate warmly and naturally, preserving the magical tone. Return only valid JSON, no markdown.`;

  const prompt = `Translate this children's story into ${targetLanguage}. Keep the same structure, warmth and magic. Only translate the text — keep imagePrompt fields in English.

Return ONLY this JSON structure:
{"title":"translated title","pages":[{"text":"translated page text","imagePrompt":"keep original English imagePrompt unchanged"}]}

Story to translate:
${JSON.stringify(story)}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        system,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return { statusCode: response.status, body: JSON.stringify({ error: err?.error?.message || 'Claude API error.' }) };
    }

    const data = await response.json();
    const text = data.content[0].text;

    let translated;
    try { translated = JSON.parse(text.replace(/```json|```/g, '').trim()); }
    catch(e) { return { statusCode: 500, body: JSON.stringify({ error: 'Could not parse translation. Please try again.' }) }; }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(translated)
    };

  } catch(err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message || 'Server error.' }) };
  }
};

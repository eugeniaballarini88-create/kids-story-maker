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

  const { name, age, gender, topic, moral, language, pages } = body;

  const ageLabel = {
    '2-3': 'toddler (2-3 years)',
    '4-5': 'preschooler (4-5 years)',
    '6-7': 'early reader (6-7 years)',
    '8-10': 'reader (8-10 years)'
  }[age] || 'child';

  const pronouns = gender === 'girl' ? 'she/her' : gender === 'boy' ? 'he/him' : 'they/them';
  const moralLine = moral ? `The story should teach: "${moral}".` : '';
  const pageCount = parseInt(pages) || 10;

  const system = `You are a warm, creative children's book author. Write age-appropriate, imaginative stories. Always write story text in ${language}. Return only valid JSON, no markdown.`;

  const prompt = `Write a children's storybook for a ${ageLabel} named ${name} (pronouns: ${pronouns}).
Topic: ${topic}. ${moralLine}

Return ONLY this JSON structure, nothing else:
{"title":"Story title","pages":[{"text":"Page text in ${language} (1-3 sentences for age ${age})","imagePrompt":"Vivid scene description in English for illustrator, child-safe, no text in image"}]}

Exactly ${pageCount} pages. Make it magical with a clear beginning, middle and end. Each page should flow naturally into the next.`;

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

    let story;
    try { story = JSON.parse(text.replace(/```json|```/g, '').trim()); }
    catch(e) { return { statusCode: 500, body: JSON.stringify({ error: 'Could not parse story. Please try again.' }) }; }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(story)
    };

  } catch(err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message || 'Server error.' }) };
  }
};

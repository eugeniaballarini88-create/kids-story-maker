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

  const { name, age, gender, topic, moral, pages } = body;

  // ── LAYER 1: TOPIC PRE-SCREENING ─────────────────────────────────────────
  const screeningPrompt = `You are a content moderation system for a children's story app designed for children aged 0-5.

Your job is to evaluate whether a story topic submitted by a parent is safe and appropriate.

HARD BLOCKS — refuse if the topic involves any of these:
- Homicide, murder, killing, death by violence
- Suicide or self-harm
- Drugs or substance use
- Alcohol
- Physical harm or intentional hurting of others
- War or armed conflict
- Sexual content of any kind
- Abuse — physical, emotional, or sexual
- Kidnapping or child endangerment
- Horror or deliberately frightening content
- Hate, discrimination, or racism
- Weapons
- Gambling
- Dark supernatural elements (demons, possession, sinister magic)
- Eating disorders or unhealthy relationships with food
- Bullying presented as acceptable or funny
- Strangers as threats or fear-inducing figures
- Nudity
- Religious indoctrination
- Political content or ideology
- Negative body image
- Harmful gender stereotyping
- Disturbing or reality-distorting content
- Graphic illness, injury, or medical procedures

ALSO REFUSE if the topic is:
- Completely unclear, meaningless, or gibberish (e.g. "asdfgh", "nothing", "???")
- Too vague to generate a safe story (e.g. "something scary", "a bad thing happened")

ALLOWED — these sensitive topics ARE permitted if handled gently:
- Death of a pet or grandparent
- New sibling, divorce, moving house
- Starting school, making friends, loneliness
- Worry, anxiety, anger
- Adoption, blended families
- A parent working away
- Disability, cultural identity
- Fear of the dark, nightmares (must resolve safely)
- Loss of a comfort object
- Doctor visits, haircuts, first experiences

Evaluate the following topic and respond with ONLY a JSON object in this exact format:
{"approved": true} if the topic is safe
{"approved": false, "reason": "A brief, friendly explanation for the parent (1-2 sentences, no jargon, warm tone)"} if refused

Topic to evaluate: "${topic || ''}"
Child name: "${name || ''}"
Child age: "${age || ''}"`;

  try {
    const screenRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 200,
        messages: [{ role: 'user', content: screeningPrompt }]
      })
    });

    const screenData = await screenRes.json();
    const screenText = screenData.content[0].text.trim();
    let screening;
    try { screening = JSON.parse(screenText.replace(/```json|```/g, '').trim()); }
    catch(e) { screening = { approved: true }; }

    if (!screening.approved) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          blocked: true,
          reason: screening.reason || "We weren't able to create a story for this topic. Please try a different theme that is suitable for young children."
        })
      };
    }
  } catch(err) {
    // If screening fails, proceed — don't block on a screening error
    console.error('Screening error:', err.message);
  }

  // ── LAYER 2: CONTROLLED GENERATION ───────────────────────────────────────
  const ageLabel = {
    '0-1': 'baby (0-1 years) — use very simple words, rhythm and repetition, 1-2 sentences per page',
    '2-3': 'toddler (2-3 years) — use simple concrete words, short sentences, 2-3 sentences per page',
    '4-5': 'preschooler (4-5 years) — use clear simple language, short paragraphs, 2-3 sentences per page'
  }[age] || 'young child (0-5 years)';

  const pronouns = gender === 'girl' ? 'she/her' : gender === 'boy' ? 'he/him' : 'they/them';
  const genderDesc = gender === 'girl' ? 'a girl' : gender === 'boy' ? 'a boy' : 'a child';
  const moralLine = moral ? `The story should gently teach: "${moral}".` : '';
  const pageCount = parseInt(pages) || 6;

  const system = `You are a specialist children's book author writing for children aged 0-5. You follow these rules absolutely and without exception.

CONTENT RULES — HARD BLOCKS (never include any of these):
- No violence, harm, or threat of any kind
- No death by violence, accident, or illness described in detail
- No scary, dark, or disturbing content
- No adult concepts — alcohol, drugs, weapons, war, politics, religion
- No negative body image or harmful gender stereotypes
- No unresolved fear or tension at any point in the story
- No cliffhangers
- No strangers presented as threatening
- No bullying presented as funny or acceptable
- No graphic descriptions of illness or medical procedures
- No disturbing transformations or reality-distorting content

EMOTIONAL RULES:
- Difficult emotions (worry, sadness, jealousy, anger) are allowed but MUST be named simply and clearly
- Every difficult emotion must be gently resolved within the story
- A trusted adult (parent, grandparent, caregiver) must be present and actively supportive
- The child in the story must always feel safe and loved
- The story must end warmly, hopefully, and reassuringly

LANGUAGE RULES:
- Use only simple, concrete vocabulary appropriate for ${ageLabel}
- Write sentences that feel natural when read aloud by a parent
- No complex metaphors or abstract concepts
- Emotions must be named explicitly (e.g. "Sofia felt worried" not "a strange feeling crept over her")

STORY STRUCTURE:
- Clear beginning, middle and end
- The child character grows or learns something by the end
- The moral must be embedded naturally — never preachy or stated directly
- Every page must flow naturally into the next

Return only valid JSON, no markdown, no explanation.`;

  const isFictional = body.mode === 'fictional';

  const jsonStructure = `Return ONLY this JSON structure:
{
  "title": "Story title",
  "pages": [
    {
      "text": "Page text in English (appropriate length for ${ageLabel})",
      "imagePrompt": "Vivid, specific scene description in English for a watercolor children's book illustrator. Describe characters, setting, mood, colors. Child-safe. No text in image."
    }
  ]
}
Exactly ${pageCount} pages. Make it warm, magical and deeply reassuring.`;

  const userPrompt = isFictional
    ? `Write a children's picture book for a ${ageLabel}.

FICTIONAL CHARACTER MODE:
- Do NOT use the child's real name. Do NOT address the reader directly.
- Invent a warm loveable animal or fantasy character as the protagonist (e.g. a little bear, a small rabbit, a tiny owl, a gentle fox).
- The character should be ${genderDesc} and face the same emotional journey described in the topic.
- The child being read to will recognise themselves in the character without being named directly.
- Give the animal character a simple warm name (e.g. Pip, Bea, Milo, Luna).
- If the topic mentions a baby brother, the baby animal is male. If baby sister, female. Do not assign a name to the baby unless specified.

Topic: ${topic}.
${moralLine}

${jsonStructure}`
    : `Write a children's storybook for a ${ageLabel} named ${name || 'the child'} (${genderDesc}, pronouns: ${pronouns}).
Topic: ${topic}.
${moralLine}

Important notes:
- ${name || 'The child'} is ${genderDesc} — use correct gender references throughout
- If the topic mentions a baby brother, the baby is a BOY. If baby sister, she is a GIRL. Do not assign a name to the baby unless specified
- Keep vocabulary and sentence length appropriate for ${ageLabel}

${jsonStructure}`;

  let story;
  try {
    const storyRes = await fetch('https://api.anthropic.com/v1/messages', {
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
        messages: [{ role: 'user', content: userPrompt }]
      })
    });

    if (!storyRes.ok) {
      const err = await storyRes.json().catch(() => ({}));
      return { statusCode: storyRes.status, body: JSON.stringify({ error: err?.error?.message || 'Story generation failed.' }) };
    }

    const storyData = await storyRes.json();
    const storyText = storyData.content[0].text;
    try { story = JSON.parse(storyText.replace(/```json|```/g, '').trim()); }
    catch(e) { return { statusCode: 500, body: JSON.stringify({ error: 'Could not read the story. Please try again.' }) }; }

    if (!story.title || !story.pages?.length) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Incomplete story received. Please try again.' }) };
    }
  } catch(err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message || 'Story generation failed.' }) };
  }

  // ── LAYER 3: STORY REVIEW ─────────────────────────────────────────────────
  const reviewPrompt = `You are a content reviewer for a children's story app for children aged 0-5.

Review the following story and check it against these criteria:

FAIL if the story contains ANY of the following:
- Violence, harm, or threat of any kind
- Dark, scary, or disturbing content
- Adult concepts (alcohol, drugs, weapons, war, politics, religion)
- Negative body image or harmful gender stereotypes
- Unresolved fear or tension
- Graphic illness descriptions
- Bullying presented as acceptable
- Content inappropriate for children aged 0-5
- Baby or sibling assigned a random name not provided by the parent

PASS if the story:
- Is warm, gentle and age-appropriate
- Names and resolves any difficult emotions positively
- Has a trusted adult present and supportive
- Ends reassuringly and hopefully
- Uses simple language appropriate for young children

Respond with ONLY a JSON object:
{"approved": true} if the story passes
{"approved": false, "reason": "Brief internal note on why it failed (for logging)"} if it fails

Story to review:
${JSON.stringify(story)}`;

  try {
    const reviewRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 200,
        messages: [{ role: 'user', content: reviewPrompt }]
      })
    });

    const reviewData = await reviewRes.json();
    const reviewText = reviewData.content[0].text.trim();
    let review;
    try { review = JSON.parse(reviewText.replace(/```json|```/g, '').trim()); }
    catch(e) { review = { approved: true }; }

    if (!review.approved) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          blocked: true,
          reason: "We weren't able to create a safe story for this topic. Please try rephrasing your theme or choosing a different topic."
        })
      };
    }
  } catch(err) {
    // If review fails, proceed — don't block on a review error
    console.error('Review error:', err.message);
  }

  // ── ALL LAYERS PASSED — RETURN STORY ──────────────────────────────────────
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(story)
  };
};

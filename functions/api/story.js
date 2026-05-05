export async function onRequestPost({ request, env }) {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return Response.json({ error: 'API key not configured.' }, { status: 500 });
  }

  let body;
  try { body = await request.json(); }
  catch(e) { return Response.json({ error: 'Invalid request body.' }, { status: 400 }); }

  const { name, age, gender, topic, moral, pages } = body;
  const isFictional = body.mode === 'fictional';

  const callClaude = async (model, messages, system, maxTokens) => {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        ...(system && { system }),
        messages
      })
    });
    const data = await res.json();
    return data?.content?.[0]?.text || '';
  };

  // ── LAYER 1: TOPIC PRE-SCREENING ─────────────────────────────────────────
  try {
    const screeningPrompt = `You are a content moderation system for a children's story app for children aged 0-5.

Evaluate whether this story topic is safe and appropriate.

HARD BLOCKS — refuse if the topic involves:
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

ALSO REFUSE if the topic is completely unclear, meaningless, or gibberish.

ALLOWED sensitive topics: death of a pet or grandparent, new sibling, divorce, moving house, starting school, making friends, loneliness, worry, anxiety, anger, adoption, blended families, parent working away, disability, cultural identity, fear of the dark, nightmares, loss of a comfort object, doctor visits, haircuts, first experiences.

Respond with ONLY valid JSON:
{"approved": true} if safe
{"approved": false, "reason": "Brief warm friendly message for the parent (1-2 sentences)"} if refused

Topic: "${topic || ''}"
Child name: "${name || ''}"
Child age: "${age || ''}"`;

    const screenText = await callClaude('claude-haiku-4-5-20251001', [{ role: 'user', content: screeningPrompt }], null, 200);
    let screening;
    try { screening = JSON.parse(screenText.replace(/```json|```/g, '').trim()); }
    catch(e) { screening = { approved: true }; }

    if (!screening.approved) {
      return Response.json({
        blocked: true,
        reason: screening.reason || "We weren't able to create a story for this topic. Please try a different theme suitable for young children."
      });
    }
  } catch(err) {
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
- Emotions must be named explicitly

STORY STRUCTURE:
- Clear beginning, middle and end
- The child character grows or learns something by the end
- The moral must be embedded naturally — never preachy
- Every page must flow naturally into the next

Return only valid JSON, no markdown, no explanation.`;

  const jsonStructure = `Return ONLY this JSON structure, no markdown:
{"title":"Story title","pages":[{"text":"Page text in English (appropriate length for ${ageLabel})","imagePrompt":"Vivid specific scene for a watercolor children's book illustrator. Describe characters, setting, mood, colors. Child-safe. No text in image."}]}
Exactly ${pageCount} pages. Make it warm, magical and deeply reassuring.`;

  const userPrompt = isFictional
    ? `Write a children's picture book for a ${ageLabel}.

FICTIONAL CHARACTER MODE:
- Do NOT use the child's real name. Do NOT address the reader directly.
- Invent a warm loveable animal or fantasy character as the protagonist.
- The character should be ${genderDesc} and face the same emotional journey described in the topic.
- Give the animal character a simple warm name (e.g. Pip, Bea, Milo, Luna).
- If the topic mentions a baby brother, the baby animal is male. If baby sister, female. Do not assign a name to the baby unless specified.

Topic: ${topic}.
${moralLine}
${jsonStructure}`
    : `Write a children's storybook for a ${ageLabel} named ${name || 'the child'} (${genderDesc}, pronouns: ${pronouns}).
Topic: ${topic}.
${moralLine}
Important: ${name || 'The child'} is ${genderDesc}. If topic mentions baby brother, baby is BOY. If baby sister, GIRL. Do not assign baby a name unless specified.
${jsonStructure}`;

  let story;
  try {
    const storyText = await callClaude('claude-sonnet-4-6', [{ role: 'user', content: userPrompt }], system, 4000);
    try { story = JSON.parse(storyText.replace(/```json|```/g, '').trim()); }
    catch(e) { return Response.json({ error: 'Could not read the story. Please try again.' }, { status: 500 }); }
    if (!story.title || !story.pages?.length) {
      return Response.json({ error: 'Incomplete story received. Please try again.' }, { status: 500 });
    }
  } catch(err) {
    return Response.json({ error: err.message || 'Story generation failed.' }, { status: 500 });
  }

  // ── LAYER 3: STORY REVIEW ─────────────────────────────────────────────────
  try {
    const reviewPrompt = `You are a content reviewer for a children's story app for children aged 0-5.

FAIL if the story contains ANY of:
- Violence, harm, or threat of any kind
- Dark, scary, or disturbing content
- Adult concepts (alcohol, drugs, weapons, war, politics, religion)
- Negative body image or harmful gender stereotypes
- Unresolved fear or tension
- Graphic illness descriptions
- Bullying presented as acceptable
- Content inappropriate for children aged 0-5
- Baby or sibling assigned a random name not provided by the parent

PASS if the story is warm, gentle, age-appropriate, resolves difficult emotions positively, has a trusted adult present, and ends reassuringly.

Respond with ONLY valid JSON:
{"approved": true} or {"approved": false, "reason": "brief note"}

Story: ${JSON.stringify(story)}`;

    const reviewText = await callClaude('claude-haiku-4-5-20251001', [{ role: 'user', content: reviewPrompt }], null, 200);
    let review;
    try { review = JSON.parse(reviewText.replace(/```json|```/g, '').trim()); }
    catch(e) { review = { approved: true }; }

    if (!review.approved) {
      return Response.json({
        blocked: true,
        reason: "We weren't able to create a safe story for this topic. Please try rephrasing or choosing a different topic."
      });
    }
  } catch(err) {
    console.error('Review error:', err.message);
  }

  // No images for now — returning story text only
  return Response.json(story);
}


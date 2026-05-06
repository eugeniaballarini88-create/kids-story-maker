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

  // LAYER 1: SCREENING
  try {
    const screenText = await callClaude('claude-haiku-4-5-20251001', [{
      role: 'user',
      content: `You are a content moderation system for a children's story app for children aged 0-5.
Evaluate whether this story topic is safe and appropriate.
HARD BLOCKS: homicide, suicide, self-harm, drugs, alcohol, violence, war, sexual content, abuse, kidnapping, horror, hate, weapons, gambling, dark magic, eating disorders, bullying as acceptable, nudity, religious indoctrination, politics, negative body image, harmful gender stereotypes, graphic illness.
ALSO REFUSE if topic is gibberish or meaningless.
ALLOWED: death of pet/grandparent, new sibling, divorce, moving, starting school, friends, loneliness, worry, anger, adoption, blended families, disability, cultural identity, nightmares, comfort object, doctor visits.
Respond ONLY with valid JSON: {"approved": true} or {"approved": false, "reason": "warm friendly message for parent"}
Topic: "${topic || ''}", Child: "${name || ''}", Age: "${age || ''}"`
    }], null, 200);

    let screening;
    try { screening = JSON.parse(screenText.replace(/```json|```/g, '').trim()); }
    catch(e) { screening = { approved: true }; }

    if (!screening.approved) {
      return Response.json({ blocked: true, reason: screening.reason || "We weren't able to create a story for this topic. Please try a different theme." });
    }
  } catch(err) {}

  // LAYER 2: GENERATION
  const ageLabel = {
    '0-1': 'baby (0-1 years) — very simple words, rhythm, repetition, 1-2 sentences per page',
    '2-3': 'toddler (2-3 years) — simple concrete words, short sentences, 2-3 sentences per page',
    '4-5': 'preschooler (4-5 years) — clear simple language, 2-3 sentences per page'
  }[age] || 'young child (0-5 years)';

  const pronouns = gender === 'girl' ? 'she/her' : gender === 'boy' ? 'he/him' : 'they/them';
  const genderDesc = gender === 'girl' ? 'a girl' : gender === 'boy' ? 'a boy' : 'a child';
  const moralLine = moral ? `Gently teach: "${moral}".` : '';
  const pageCount = parseInt(pages) || 6;

  const system = `You are a specialist children's book author for ages 0-5.
NEVER include: violence, scary content, adult concepts, unresolved fear, harmful stereotypes, cliffhangers.
ALWAYS: name emotions simply, resolve them gently, include a supportive trusted adult, end warmly and reassuringly.
Use simple vocabulary appropriate for ${ageLabel}. Return only valid JSON, no markdown.`;

  const prompt = isFictional
    ? `Write a children's picture book for a ${ageLabel}. Invent a warm animal character (${genderDesc}), give them a simple name (Pip, Bea, Milo, Luna). Do NOT use the child's real name. Topic: ${topic}. ${moralLine}
Return ONLY: {"title":"...","pages":[{"text":"...","imagePrompt":"..."}]} — exactly ${pageCount} pages.`
    : `Write a children's storybook for ${name || 'the child'} (${ageLabel}, ${genderDesc}, ${pronouns}). Topic: ${topic}. ${moralLine} Baby brother=BOY, baby sister=GIRL, no baby name unless given.
Return ONLY: {"title":"...","pages":[{"text":"...","imagePrompt":"..."}]} — exactly ${pageCount} pages.`;

  let story;
  try {
    const text = await callClaude('claude-sonnet-4-6', [{ role: 'user', content: prompt }], system, 4000);
    story = JSON.parse(text.replace(/```json|```/g, '').trim());
    if (!story.title || !story.pages?.length) throw new Error('Incomplete story.');
  } catch(err) {
    return Response.json({ error: 'Could not generate story. Please try again.' }, { status: 500 });
  }

  // LAYER 3: REVIEW
  try {
    const reviewText = await callClaude('claude-haiku-4-5-20251001', [{
      role: 'user',
      content: `Review this children's story for ages 0-5. FAIL if: violence, dark content, adult concepts, unresolved fear, harmful stereotypes, random baby name. PASS if: warm, gentle, age-appropriate, emotions resolved, trusted adult present, reassuring ending. Respond ONLY: {"approved":true} or {"approved":false}. Story: ${JSON.stringify(story)}`
    }], null, 100);

    let review;
    try { review = JSON.parse(reviewText.replace(/```json|```/g, '').trim()); }
    catch(e) { review = { approved: true }; }

    if (!review.approved) {
      return Response.json({ blocked: true, reason: "We weren't able to create a safe story for this topic. Please try a different theme." });
    }
  } catch(err) {}

  return Response.json(story);
}

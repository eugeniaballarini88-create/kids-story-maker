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
    if (!res.ok) throw new Error(data?.error?.message || 'Claude API error ' + res.status);
    const text = data?.content?.[0]?.text;
    if (!text) throw new Error('Empty response from Claude API');
    return text;
  };

  // ── LAYER 1: TOPIC PRE-SCREENING ─────────────────────────────────────────
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

  // ── LAYER 2: CONTROLLED GENERATION ───────────────────────────────────────
  const ageLabel = {
    '0-1': 'baby (0-1 years) — very simple words, rhythm, repetition, 1-2 sentences per page',
    '2-3': 'toddler (2-3 years) — simple concrete words, short sentences, 2-3 sentences per page',
    '4-5': 'preschooler (4-5 years) — clear simple language, 2-3 sentences per page'
  }[age] || 'young child (0-5 years)';

  const pronouns = gender === 'girl' ? 'she/her' : gender === 'boy' ? 'he/him' : 'they/them';
  const genderDesc = gender === 'girl' ? 'a girl' : gender === 'boy' ? 'a boy' : 'a child';
  const moralLine = moral ? `Gently teach: "${moral}".` : '';
  const pageCount = parseInt(pages) || 6;

  const system = `You are a specialist children's book author for ages 0-5 with a rich, varied writing style.

CONTENT RULES — never include:
Violence, scary content, adult concepts, unresolved fear, harmful stereotypes, cliffhangers, strangers as threats.

EMOTIONAL RULES — always:
Name emotions simply and clearly. Resolve difficult emotions gently. Include a supportive trusted adult. End warmly and reassuringly.

LANGUAGE RULES:
- Use simple, concrete vocabulary appropriate for ${ageLabel}
- Write sentences that feel natural when read aloud
- Vary your sentence length — mix short punchy sentences with longer flowing ones
- Use fresh, specific sensory details (sounds, textures, smells, colours) to bring scenes alive
- AVOID overused phrases: "wobbly feeling", "biggest smile", "heart went thump", "took a deep breath", "felt a funny feeling", "warm and safe", "eyes lit up"
- AVOID repeating the same descriptive word more than once per story
- Each page should have its own distinct emotional tone — not every page can be warm and cosy
- The story must have a real narrative arc: a problem or challenge, a moment of doubt or difficulty, and a satisfying resolution
- Surprise the reader — include at least one unexpected detail, image or moment that feels fresh and specific

STORY STRUCTURE:
- Page 1: Establish the character and their world vividly
- Pages 2-3: Introduce the challenge or change — the character should feel something real (worry, excitement mixed with fear, sadness, confusion)
- Pages 4-6: The character tries, struggles slightly, gets support
- Final pages: Resolution that feels earned — not instant, not magical, but warm and true
- The moral must be shown through action, never stated directly

IMAGE PROMPT RULES — for every page imagePrompt:
- Start with a SHORT character description tag like: [CHAR: girl, black curly hair, blue eyes, red dress] — invent this once and repeat it identically on every single page
- Then describe the scene for that page
- Focus on environment and mood rather than close-up of characters
- Avoid describing hands, fingers or arms in detail
- End with the mood/lighting
- Example: "[CHAR: small brown rabbit, white fluffy tail, yellow scarf] sitting alone under a big oak tree, looking up at falling autumn leaves, soft golden afternoon light"
- The character tag MUST be identical on every page — same words, same order

Return only valid JSON, no markdown.`;

  const prompt = isFictional
    ? `Write a children's picture book for a ${ageLabel}. Invent a warm animal character (${genderDesc}), invent a fresh original name that fits their personality and species — avoid reusing common names, surprise us. Do NOT use the child's real name. Topic: ${topic}. ${moralLine}
Return ONLY: {"title":"...","characterDescription":"one sentence physical description of the main character","pages":[{"text":"...","imagePrompt":"..."}]} — exactly ${pageCount} pages.`
    : `Write a children's storybook for ${name || 'the child'} (${ageLabel}, ${genderDesc}, ${pronouns}). Topic: ${topic}. ${moralLine} Baby brother=BOY, baby sister=GIRL, no baby name unless given.
Return ONLY: {"title":"...","characterDescription":"one sentence physical description of the main character","pages":[{"text":"...","imagePrompt":"..."}]} — exactly ${pageCount} pages.`;

  let story;
  try {
    const text = await callClaude('claude-sonnet-4-6', [{ role: 'user', content: prompt }], system, 4000);
    if (!text) return Response.json({ error: 'Empty response from Claude.' }, { status: 500 });
    const cleaned = text.replace(/```json|```/g, '').trim();
    try {
      story = JSON.parse(cleaned);
    } catch(parseErr) {
      return Response.json({ error: 'JSON parse failed: ' + cleaned.slice(0, 100) }, { status: 500 });
    }
    if (!story.title || !story.pages?.length) {
      return Response.json({ error: 'Incomplete story: ' + JSON.stringify(story).slice(0, 100) }, { status: 500 });
    }
  } catch(err) {
    return Response.json({ error: 'Claude call failed: ' + err.message }, { status: 500 });
  }

  // ── LAYER 3: STORY REVIEW ─────────────────────────────────────────────────
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

  // ── GENERATE ALL IMAGES WITH CLOUDFLARE WORKERS AI ───────────────────────
  if (env.AI) {
    const IMG_STYLE = "watercolor children's book illustration, soft pastel palette, gentle brushstrokes, wide establishing shot, characters shown from distance, cosy and warm atmosphere, no text, no words, no letters";

    const generateImage = async (prompt) => {
      try {
        const response = await env.AI.run('@cf/black-forest-labs/flux-1-schnell', {
          prompt: prompt,
          num_steps: 4,
        });
        if (response && response.image) {
          return 'data:image/jpeg;base64,' + response.image;
        }
        return null;
      } catch(err) {
        console.error('Image error:', err.message);
        return null;
      }
    };

    // Cover image
    try {
      const coverPrompt = (story.pages[0] ? story.pages[0].imagePrompt : "a warm friendly children's book cover scene") + ', ' + IMG_STYLE + ', no title, no text, no letters, no words anywhere in the image';
      story.coverImage = await generateImage(coverPrompt);
    } catch(err) {
      console.error('Cover image failed:', err.message);
      story.coverImage = null;
    }

    // Page images — one by one
    for (let i = 0; i < story.pages.length; i++) {
      try {
        const pagePrompt = story.pages[i].imagePrompt + ', ' + IMG_STYLE + ', no text, no words, no letters';
        story.pages[i].image = await generateImage(pagePrompt);
      } catch(err) {
        console.error('Page ' + (i + 1) + ' image failed:', err.message);
        story.pages[i].image = null;
      }
    }
  }

  return Response.json(story);
}

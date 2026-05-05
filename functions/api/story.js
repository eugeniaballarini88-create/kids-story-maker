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
- No scary, dark, or disturbing content
- No adult concepts — alcohol, drugs, weapons, war, politics, religion
- No negative body image or harmful gender stereotypes
- No unresolved fear or tension at any point in the story
- No cliffhangers
- No strangers presented as threatening
- No bullying presented as funny or acceptable

EMOTIONAL RULES:
- Difficult emotions must be named simply and clearly
- Every difficult emotion must be gently resolved within the story
- A trusted adult must be present and actively supportive
- The story must end warmly, hopefully, and reassuringly

LANGUAGE RULES:
- Simple, concrete vocabulary appropriate for ${ageLabel}
- Short sentences natural when read aloud
- Emotions named explicitly

Return only valid JSON, no markdown.`;

  const jsonStructure = `Return ONLY this JSON, no markdown:
{"title":"Story title","pages":[{"text":"Page text (appropriate for ${ageLabel})","imagePrompt":"Vivid watercolor children's book scene. Describe characters, setting, mood, colors. Child-safe. No text in image."}]}
Exactly ${pageCount} pages. Warm, magical, deeply reassuring.`;

  const userPrompt = isFictional
    ? `Write a children's picture book for a ${ageLabel}.
FICTIONAL CHARACTER MODE: Invent a warm animal character (${genderDesc}). Give them a simple name (Pip, Bea, Milo, Luna). Do NOT use the child's real name.
Topic: ${topic}. ${moralLine}
${jsonStructure}`
    : `Write a children's storybook for ${name || 'the child'} (${ageLabel}, ${genderDesc}, pronouns: ${pronouns}).
Topic: ${topic}. ${moralLine}
${name || 'The child'} is ${genderDesc}. Baby brother = BOY, baby sister = GIRL. No name for baby unless specified.
${jsonStructure}`;

  let story;
  try {
    const storyText = await callClaude('claude-sonnet-4-6', [{ role: 'user', content: userPrompt }], system, 4000);
    try { story = JSON.parse(storyText.replace(/```json|```/g, '').trim()); }
    catch(e) { return Response.json({ error: 'Could not read the story. Please try again.' }, { status: 500 }); }
    if (!story.title || !story.pages?.length) {
      return Response.json({ error: 'Incomplete story. Please try again.' }, { status: 500 });
    }
  } catch(err) {
    return Response.json({ error: err.message || 'Story generation failed.' }, { status: 500 });
  }

  // ── LAYER 3: STORY REVIEW ─────────────────────────────────────────────────
  try {
    const reviewPrompt = `Review this children's story for children aged 0-5.
FAIL if: violence, dark content, adult concepts, unresolved fear, harmful stereotypes, baby given random name.
PASS if: warm, gentle, age-appropriate, emotions resolved, trusted adult present, reassuring ending.
Respond ONLY: {"approved": true} or {"approved": false}
Story: ${JSON.stringify(story)}`;

    const reviewText = await callClaude('claude-haiku-4-5-20251001', [{ role: 'user', content: reviewPrompt }], null, 100);
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

  // ── GENERATE IMAGES WITH CLOUDFLARE WORKERS AI ────────────────────────────
  if (env.AI) {
    try {
      const IMG_STYLE = "watercolor illustration, children's picture book, soft pastel colors, whimsical, warm, gentle brushstrokes, child-safe, no text";

      const generateImage = async (prompt) => {
        try {
          const response = await env.AI.run('@cf/black-forest-labs/flux-1-schnell', {
            prompt: `${prompt}, ${IMG_STYLE}`,
            num_steps: 4,
          });

          // Handle ReadableStream response
          if (response && typeof response.getReader === 'function') {
            const reader = response.getReader();
            const chunks = [];
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value) chunks.push(value);
            }
            if (chunks.length === 0) return null;
            const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
            const combined = new Uint8Array(totalLength);
            let offset = 0;
            for (const chunk of chunks) {
              combined.set(chunk, offset);
              offset += chunk.length;
            }
            const base64 = btoa(String.fromCharCode(...combined));
            return `data:image/jpeg;base64,${base64}`;
          }

          // Handle {image: base64string} response
          if (response?.image) {
            return `data:image/jpeg;base64,${response.image}`;
          }

          return null;
        } catch(err) {
          console.error('Image error:', err.message);
          return null;
        }
      };

      // Generate cover image
      const coverPrompt = `children's book cover for "${story.title}", ${story.pages[0]?.imagePrompt}`;
      story.coverImage = await generateImage(coverPrompt);

      // Generate page images sequentially
      for (let i = 0; i < story.pages.length; i++) {
        story.pages[i].image = await generateImage(story.pages[i].imagePrompt);
      }

    } catch(err) {
      console.error('Image generation error:', err.message);
    }
  }

  return Response.json(story);
}

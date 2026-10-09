// Controlled chunks exercise visible intermediate states, without paid providers.
const assert = require('node:assert/strict');

module.exports = async function checkReaderStream(page, citation, answer) {
  await page.evaluate(() => {
    const originalFetch = window.fetch;
    const encoder = new TextEncoder();
    window.readerStreamFixture = {started: false, cancelled: false, httpError: false};
    window.fetch = async (url, options) => {
      if (url !== '/api/ask/stream') return originalFetch(url, options);
      const fixture = window.readerStreamFixture;
      fixture.started = true;
      fixture.cancelled = false;
      if (fixture.httpError) return new Response(JSON.stringify({error: 'The archive is temporarily unavailable. Please retry.'}), {status: 503});
      return new Response(new ReadableStream({
        start(controller) {
          fixture.bytes = bytes => controller.enqueue(new Uint8Array(bytes));
          fixture.raw = text => controller.enqueue(encoder.encode(text));
          fixture.send = event => fixture.raw(JSON.stringify(event) + '\n');
          fixture.close = () => controller.close();
          options.signal.addEventListener('abort', () => {
            try { controller.error(new DOMException('Aborted', 'AbortError')); } catch {}
          }, {once: true});
        },
        cancel() { fixture.cancelled = true; },
      }), {headers: {'Content-Type': 'application/x-ndjson'}});
    };
  });
  const start = async question => {
    await page.evaluate(() => { window.readerStreamFixture.started = false; });
    await page.locator('#question').fill(question);
    await page.locator('#question').press('Enter');
    await page.waitForFunction(() => window.readerStreamFixture.started);
  };
  const send = event => page.evaluate(event => window.readerStreamFixture.send(event), event);
  const done = () => page.waitForFunction(() => !document.querySelector('#ask-button').disabled);
  const noClips = async () => {
    assert.equal(await page.locator('#moments-section').isVisible(), false);
    assert.equal(await page.locator('#moments .moment').count(), 0);
    assert.equal(await page.locator('#watch-panel').isVisible(), false);
  };
  const candidates = {type: 'excerpts', excerpts: [citation], message: 'Retrieved a candidate'};

  await page.clock.install();
  await start('How can I focus better?');
  await send(candidates);
  await send({type: 'detail', phase: 'search', message: 'Found 4 candidate passages in 2 conversations'});
  await page.waitForFunction(() => document.querySelector('[data-phase=search] .reasoning-feed').textContent.includes('Found 4 candidate passages'));
  assert.equal(await page.locator('[data-phase=search] thinking-orb').count(), 1, 'The running step carries a thinking orb');
  assert.equal(await page.locator('#assistant-orb').getAttribute('paused'), null, 'The assistant orb animates while busy');
  await send({type: 'stage', phase: 'review', message: 'Checking source clips…'});
  assert.equal(await page.locator('[data-phase=review]').getAttribute('aria-current'), 'step');
  assert.equal(await page.locator('[data-phase=search] .reasoning-feed').textContent(), '', 'Finished steps collapse to a check');
  assert.equal(await page.locator('[data-phase=search] thinking-orb').count(), 0);
  await send({type: 'detail', phase: 'review', message: 'Verified clip 1 against its transcript'});
  await page.waitForFunction(() => document.querySelector('[data-phase=review] .reasoning-feed .latest')?.textContent === 'Verified clip 1 against its transcript');
  assert.equal(await page.locator('[data-phase=compose] .phase-state').textContent(), 'Waiting');
  assert.equal(await page.locator('#answer-step').textContent(), 'Step 2 of 3');
  await page.clock.fastForward(5000);
  assert.equal(await page.locator('[data-phase=review]').getAttribute('aria-current'), 'step', 'Elapsed time must not advance server progress');
  await send({type: 'stage', phase: 'compose', message: 'Checking the sources…'});
  await page.waitForFunction(() => document.querySelector('#request-status').textContent === 'Checking the sources…');
  await noClips();
  assert.equal(await page.locator('#answer').textContent(), '');
  assert.equal(await page.locator('#answer').getAttribute('aria-busy'), 'true');
  assert.equal(await page.locator('#answer-composer').isVisible(), false);
  assert.equal(await page.locator('#ask-again').isVisible(), false);
  assert.equal(await page.locator('#question-form').isVisible(), false);
  assert.equal(await page.locator('[data-phase=compose]').getAttribute('aria-current'), 'step');
  assert.equal(await page.locator('[data-phase=search] .phase-state').textContent(), 'Done');
  assert.equal(await page.locator('[data-phase=review] .phase-state').textContent(), 'Done');
  assert.equal(await page.locator('#answer-step').textContent(), 'Step 3 of 3');
  await page.clock.fastForward(2000);
  assert.match(await page.locator('#answer-elapsed').textContent(), /^Elapsed 0:0[2-9]$/);
  await page.locator('.main-nav [data-view=discover]').click();
  assert.equal(await page.locator('#question-form').isVisible(), false, 'Do not offer a second question on another view while busy');
  await page.locator('#return-to-answer').click();
  assert.equal(await page.locator('[data-phase=compose]').getAttribute('aria-current'), 'step');

  // A final answer is terminal even if the socket stays open or trailing data is bad.
  await page.evaluate(answer => window.readerStreamFixture.raw(
    JSON.stringify({type: 'answer', response: answer}) + '\n' + '{bad trailing data}\n'), answer);
  await done();
  assert.equal(await page.locator('.moment').count(), 1);
  assert.equal(await page.locator('.answer-prose').isVisible(), true);
  assert.equal(await page.evaluate(() => window.readerStreamFixture.cancelled), true);
  assert.equal(await page.locator('#answer').getAttribute('aria-busy'), 'false');
  assert.equal(await page.locator('#answer-progress').isVisible(), false);
  assert.equal(await page.locator('#answer-composer').isVisible(), true);
  assert.equal(await page.locator('#assistant-orb').getAttribute('paused'), '', 'The assistant orb rests after the answer');
  assert.match(await page.locator('#reasoning-summary-label').textContent(), /^How this answer was checked · 0:\d\d$/);
  await page.locator('#reasoning-summary > summary').click();
  assert.deepEqual(await page.locator('#reasoning-log > li > strong').allTextContents(), ['Search conversations', 'Check source clips']);
  assert.match(await page.locator('#reasoning-log').textContent(), /Verified clip 1 against its transcript/);
  const finishedElapsed = await page.locator('#answer-elapsed').textContent();
  await page.clock.fastForward(2000);
  assert.equal(await page.locator('#answer-elapsed').textContent(), finishedElapsed, 'Stop the timer when the answer completes');
  assert.equal(await page.evaluate(() => {
    const nodes = ['answer', 'moments-section', 'answer-composer'].map(id => document.getElementById(id));
    return nodes.slice(1).every((node, i) => nodes[i].compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING);
  }), true, 'Keep the reading order: answer, sources, then the next-question composer');

  const outcomes = [
    {status: 'insufficient_evidence', message: 'I could not find a useful match in the retrieved video excerpts.'},
    {status: 'needs_clarification', message: 'Which two options do you want to compare?'},
    {status: 'invalid_evidence', message: 'I could not verify an answer. Please try again.'},
    {error: 'The answer provider is temporarily unavailable. Please retry.'},
  ];
  for (const outcome of outcomes) {
    await start('how to cook maggie');
    await send(candidates);
    // A no-answer outcome must also discard unexpected/stale final recommendations.
    await send({type: 'answer', response: {...answer, ...outcome}});
    await done();
    assert.equal(await page.locator('#answer-progress').isVisible(), false);
    assert.equal(await page.locator('#question-form').isVisible(), true);
    await noClips();
    assert.equal(await page.locator('#answer').textContent(), outcome.error || outcome.message);
  }

  await start('A request whose connection ends early');
  await send(candidates);
  await page.evaluate(() => window.readerStreamFixture.close());
  await done();
  await noClips();
  assert.match(await page.locator('#request-status').textContent(), /connection ended before your answer/);
  assert.equal(await page.locator('#retry-question').isVisible(), true);

  await start('A malformed response');
  await page.evaluate(() => window.readerStreamFixture.raw('{broken JSON}\n'));
  await done();
  await noClips();
  assert.match(await page.locator('#request-status').textContent(), /could not be read/);

  // Both JSON and a multi-byte character cross arbitrary network chunk boundaries.
  await start('A split response');
  const text = 'Keep a consistent routine—it can help you focus.';
  await page.evaluate(({answer, text}) => {
    const response = {...answer, points: [{...answer.points[0], text}]};
    const bytes = new TextEncoder().encode(JSON.stringify({type: 'answer', response}));
    const split = bytes.indexOf(0xe2) + 1;
    window.readerStreamFixture.bytes(bytes.slice(0, split));
    window.readerStreamFixture.remaining = Array.from(bytes.slice(split));
  }, {answer, text});
  await noClips();
  await page.evaluate(() => {
    window.readerStreamFixture.bytes(window.readerStreamFixture.remaining);
    window.readerStreamFixture.close(); // A final line without a newline is valid.
  });
  await done();
  assert.ok((await page.locator('.answer-prose').textContent()).startsWith(text));

  await page.evaluate(() => { window.readerStreamFixture.httpError = true; });
  await start('An unavailable server');
  await done();
  await noClips();
  assert.match(await page.locator('#request-status').textContent(), /temporarily unavailable/);
  await page.evaluate(() => { window.readerStreamFixture.httpError = false; });

  await start('A question I want to edit');
  await send(candidates);
  await page.locator('#cancel-question').click();
  await done();
  await noClips();
  assert.match(await page.locator('#request-status').textContent(), /Stopped waiting/);
  assert.equal(await page.locator('#question').inputValue(), 'A question I want to edit');
  assert.equal(await page.locator('#retry-question').isVisible(), false);
  assert.equal(await page.locator('#answer-progress').isVisible(), false);
  assert.equal(await page.locator('#question').isVisible(), true);
  // A response queued after abort cannot replace the cancelled state.
  await page.evaluate(answer => {
    try { window.readerStreamFixture.send({type: 'answer', response: answer}); } catch {}
  }, answer);
  await noClips();
  await start('The edited question');
  await send({type: 'answer', response: answer});
  await done();
  assert.equal(await page.locator('.answer-prose').isVisible(), true);

  await start('A stalled request');
  assert.equal(await page.locator('[data-phase=search]').getAttribute('aria-current'), 'step', 'Reset progress for each request');
  await send(candidates);
  await page.clock.fastForward(31000);
  assert.match(await page.locator('#request-status').textContent(), /taking longer than usual/);
  await noClips();
  assert.equal(await page.locator('#question').isVisible(), false);
  await page.clock.fastForward(270000);
  await done();
  await noClips();
  assert.match(await page.locator('#request-status').textContent(), /taking too long/);
  assert.equal(await page.locator('#retry-question').isVisible(), true);
  assert.equal(await page.locator('#question').isVisible(), true, 'Restore the form after a timeout');
  assert.equal(await page.locator('#answer-progress').isVisible(), false);
  await page.clock.resume();

  // A failed attempt must not prevent the next question from completing normally.
  await start('A recovered request');
  await send({type: 'answer', response: answer});
  await done();
  assert.equal(await page.locator('.answer-prose').isVisible(), true);
  assert.equal(await page.locator('#retry-question').isVisible(), false);
  console.log('Stream checks passed: held candidates, terminal answer, no match, clarification, rejected evidence, provider errors, disconnect, malformed JSON, split UTF-8, HTTP errors, cancellation, timeout, and recovery.');
};

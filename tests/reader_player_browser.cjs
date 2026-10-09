// Isolated reader playback checks: no server, screenshots or external requests.
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

(async () => {
  const origin = 'https://reader.example.test';
  const assets = path.join(__dirname, '../knowledge/web');
  const browser = await chromium.launch(process.env.CHROME_PATH
    ? {headless: true, executablePath: process.env.CHROME_PATH}
    : {headless: true, channel: 'chrome'});
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const types = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
      '.json': 'application/json', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png', '.woff2': 'font/woff2'};
    const allowed = new Set(['index.html', 'reader.js', 'theme.js', 'reader.css', 'orb.js', 'thinking-orbs.js',
      'catalog.json', 'favicon.svg', 'geist-latin.woff2', 'media/huberman.png', 'media/raj-shamani.jpg']);
    await page.context().route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === 'https://www.youtube-nocookie.com') {
        return route.fulfill({contentType: 'text/html', body: '<p>Offline player fixture</p>'});
      }
      if (url.origin === 'https://www.youtube.com' && url.pathname === '/watch') {
        return route.fulfill({contentType: 'text/html', body: '<p>Full video fixture</p>'});
      }
      if (url.origin !== origin) return route.abort();
      if (url.pathname === '/api/status') return route.fulfill({json: {sources: [], credentials: {}}});
      if (url.pathname === '/api/responses') return route.fulfill({json: {items: [], total: 0}});
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!allowed.has(name)) throw new Error('Unexpected reader request: ' + url.pathname);
      const file = name === 'reader.js' && process.argv[2] ? process.argv[2] : path.join(assets, name);
      return route.fulfill({body: await fs.readFile(file), contentType: types[path.extname(name)],
        // Reproduce the production policy; the iframe must send only the origin.
        headers: {'Referrer-Policy': 'no-referrer'}});
    });
    await page.goto(origin + '/?question=private#discover');
    await page.locator('.editorial-lead').waitFor();
    await page.waitForFunction(() => document.querySelector('#ask-button').getAttribute('aria-label') !== 'Search the archive');

    const first = {source_id: 'Y566_T-YlNQ', title: 'Playback fixture', start: 100.25, end: 106.75,
      time_range: '1:40–1:46', quote: 'First synthetic excerpt.'};
    const second = {...first, start: 2144.56, end: 2268.56, time_range: '35:44–37:48', quote: 'Second synthetic excerpt.'};
    await page.evaluate(clips => {
      beginAnswer('Playback fixture');
      renderAnswer({status: 'answered', points: [{text: 'Synthetic answer.', citations: clips}],
        recommendations: clips.map(citation => ({citation}))});
    }, [first, second]);

    async function checkPlayback(click, container, start, end, videoID = first.source_id) {
      const [request] = await Promise.all([
        page.waitForRequest(request => request.url().startsWith('https://www.youtube-nocookie.com/embed/'), {timeout: 10000})
          .catch(async error => {
            console.error('Player state:', await page.evaluate(() => ({
              frames: [...document.querySelectorAll('iframe')].map(frame => frame.src),
              dialogOpen: document.querySelector('#video-dialog').open,
              toast: document.querySelector('#toast').textContent,
            })), errors);
            throw error;
          }),
        click(),
      ]);
      const url = new URL(request.url());
      assert.equal(url.pathname, '/embed/' + videoID);
      assert.equal(url.searchParams.get('start'), start);
      assert.equal(url.searchParams.get('end'), end);
      assert.equal((await request.allHeaders()).referer, origin + '/', 'YouTube needs the origin; never send the question or route');
      assert.equal(await page.locator(container + ' iframe').getAttribute('src'), request.url());
      assert.equal(await page.locator('iframe').count(), 1, 'Only the selected video can play');
    }
    assert.equal(await page.locator('#watch-panel').isVisible(), false, 'No extra player preview before selecting a clip');
    assert.equal(await page.locator('.moment details, .moment blockquote').count(), 0);
    assert.equal(await page.locator('.moment-actions > *').count(), 4, 'Exactly two playback choices per clip');
    for (const link of await page.locator('.moment-actions a').all()) {
      assert.equal(await link.textContent(), 'Full video');
      assert.equal(await link.getAttribute('href'), 'https://www.youtube.com/watch?v=' + first.source_id);
      assert.equal(await link.getAttribute('target'), '_blank');
      assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
    }
    const playFirst = () => page.locator('#moments').getByRole('button', {name: 'Play clip 1: 1:40–1:47', exact: true}).click();
    await checkPlayback(playFirst, '#watch-container', '100', '107');
    assert.equal(await page.locator('#watch-details a').count(), 0);
    assert.match(await page.locator('#watch-details').textContent(), /Stops at 1:47/);
    await checkPlayback(() => page.locator('#moments').getByRole('button', {name: 'Play clip 2: 35:44–37:49', exact: true}).click(),
      '#watch-container', '2144', '2269');
    await checkPlayback(playFirst, '#watch-container', '100', '107');
    await page.getByRole('button', {name: 'Close supporting video', exact: true}).click();
    assert.equal(await page.locator('iframe').count(), 0);
    const answerURL = page.url();
    assert.equal(await page.locator('.citation-link').first().getAttribute('type'), 'button');
    await page.locator('.citation-link').nth(1).focus();
    await checkPlayback(() => page.keyboard.press('Enter'), '#watch-container', '2144', '2269');
    assert.equal(page.url(), answerURL, 'Answer references play the correct clip without navigating');
    const [fullVideo] = await Promise.all([
      page.waitForEvent('popup'), page.locator('#moment-2 .moment-actions a').click(),
    ]);
    await fullVideo.waitForLoadState('domcontentloaded');
    assert.equal(fullVideo.url(), 'https://www.youtube.com/watch?v=' + first.source_id);
    assert.equal(page.url(), answerURL);
    assert.equal(await page.locator('iframe').count(), 0, 'Opening the full video stops the embedded clip');
    await fullVideo.close();

    await page.getByRole('button', {name: 'Save this clip', exact: true}).first().click();
    await page.getByRole('button', {name: 'Change collection', exact: true}).click();
    await page.locator('#collection-name').fill('Playback checks');
    await page.locator('#confirm-save').click();
    await page.locator('#save-dialog').waitFor({state: 'hidden'});
    await page.locator('.main-nav [data-view=saved]').click();
    await page.reload();
    await page.locator('#collection-tabs button').filter({hasText: 'Playback checks'}).click();
    assert.equal(await page.locator('#saved-grid .episode-meta').textContent(), 'Saved clip · 1:40–1:47 · 0:07');
    await checkPlayback(() => page.locator('#saved-grid .episode-art').click(), '#video-container', '100', '107');
    assert.equal(await page.locator('#video-external').getAttribute('href'), 'https://www.youtube.com/watch?v=' + first.source_id);
    const [savedFullVideo] = await Promise.all([
      page.waitForEvent('popup'), page.locator('#video-external').click(),
    ]);
    await savedFullVideo.waitForLoadState('domcontentloaded');
    assert.equal(savedFullVideo.url(), 'https://www.youtube.com/watch?v=' + first.source_id);
    assert.equal(await page.locator('#video-dialog').evaluate(dialog => dialog.open), false);
    await savedFullVideo.close();
    await page.locator('#video-container iframe').waitFor({state: 'detached'});
    // Clips sharing a start point can have different ends and must remain distinct.
    await page.evaluate(clip => openSave({...clip, kind: 'moment', end: 130}), first);
    await page.locator('#confirm-save').click();
    await page.locator('#save-dialog').waitFor({state: 'hidden'});
    assert.equal(await page.locator('#saved-grid .catalog-card').count(), 2);
    assert.deepEqual(await page.locator('#saved-grid .episode-meta').allTextContents(), ['Saved clip · 1:40–1:47 · 0:07', 'Saved clip · 1:40–2:10 · 0:30']);
    await page.locator('.main-nav [data-view=discover]').click();
    await checkPlayback(() => page.locator('.editorial-lead .episode-art').click(),
      '#video-container', null, null, '46P1rL0rzPE');
    await page.getByRole('button', {name: 'Close video', exact: true}).click();
    await page.locator('#video-container iframe').waitFor({state: 'detached'});

    // Saved responses can omit cards, duplicate them, or cite another video at the same time.
    const other = {...first, source_id: 'abcdefghijk', title: 'Another conversation'};
    const prose = 'The two conversations offer different perspectives.';
    await page.evaluate(({first, other, prose}) => {
      beginAnswer('Reference matching');
      renderAnswer({status: 'answered', points: [{text: prose, citations: [first, other, first]}],
        recommendations: [{citation: first, summary: 'First summary.', limitation: 'This only covers one perspective.'},
          {citation: first, summary: 'Duplicate card.'}, {citation: {...first, end: first.start}},
          {citation: {...first, source_id: 'bad/video/id'}}]});
    }, {first, other, prose});
    assert.equal(await page.locator('.moment').count(), 2);
    assert.deepEqual(await page.locator('.citation-link').allTextContents(), ['1', '2']);
    assert.equal(await page.locator('.answer-prose p').evaluate(node => node.firstChild.textContent), prose);
    assert.equal(await page.locator('.moment-limit').textContent(), 'This only covers one perspective.');
    await checkPlayback(() => page.locator('.citation-link').nth(1).click(), '#watch-container', '100', '107', other.source_id);
    assert.equal(await page.locator('#moment-2 .moment-actions a').getAttribute('href'), 'https://www.youtube.com/watch?v=' + other.source_id);
    await page.evaluate(first => renderAnswer({status: 'answered', recommendations: [],
      points: [{text: 'A saved answer without a separate card list.', citations: [first]}]}), first);
    assert.equal(await page.locator('.moment').count(), 1);
    await checkPlayback(() => page.locator('.citation-link').click(), '#watch-container', '100', '107');

    // Drive the official API callbacks deterministically, including a seek past
    // the end that could otherwise defeat YouTube's embed end parameter.
    await page.clock.install();
    await page.evaluate(({first, second}) => {
      window.playerFixtures = [];
      window.YT = {Player: function(frame, {events}) {
        const player = {current: 100, pauses: 0, destroyed: false,
          getCurrentTime() { return this.current; },
          pauseVideo() { this.pauses++; events.onStateChange({data: 2}); },
          destroy() { this.destroyed = true; }, events};
        window.playerFixtures.push(player);
        setTimeout(() => { events.onReady({target: player}); events.onStateChange({data: 1}); }, 0);
        return player;
      }};
      renderAnswer({status: 'answered', answer_parts: [
        {text: 'Start with a consistent routine.', citations: [first]},
        {text: 'Build in a regular break.', citations: [second]},
      ], answer_limitation: 'These excerpts do not establish a personal outcome.',
      recommendations: [{citation: first, clip_title: 'Building a consistent routine', summary: 'A checked summary.'},
        {citation: second, clip_title: 'Taking regular breaks'}]});
    }, {first, second});
    assert.deepEqual(await page.locator('.answer-prose .citation-link').allTextContents(), ['1', '2']);
    assert.equal(await page.locator('.answer-points li').count(), 1);
    assert.equal(await page.locator('.answer-limitation').textContent(), 'These excerpts do not establish a personal outcome.');
    assert.equal(await page.locator('#moment-1 h3').textContent(), 'Building a consistent routine');
    await page.setViewportSize({width: 390, height: 844});
    await checkPlayback(playFirst, '#watch-container', '100', '107');
    await page.clock.fastForward(400);
    assert.equal(await page.locator('#moment-1 > #watch-panel').count(), 1, 'The player stays inside the selected clip on mobile');
    await page.evaluate(() => { window.playerFixtures.at(-1).current = 106.9; });
    await page.clock.fastForward(400);
    assert.match(await page.locator('#clip-playback-status').textContent(), /Playing/);
    await page.evaluate(() => { window.playerFixtures.at(-1).current = 107; });
    await page.clock.fastForward(400);
    assert.match(await page.locator('#clip-playback-status').textContent(), /Clip finished/);
    assert.equal(await page.evaluate(() => window.playerFixtures.at(-1).pauses), 1);
    await checkPlayback(() => page.getByRole('button', {name: 'Replay clip 1: 1:40–1:47', exact: true}).click(), '#watch-container', '100', '107');
    await page.clock.fastForward(400);
    assert.equal(await page.evaluate(() => window.playerFixtures[0].destroyed), true);
    await page.evaluate(() => { const player = window.playerFixtures.at(-1); player.current = 150; player.events.onStateChange({data: 1}); });
    await page.clock.fastForward(400);
    assert.match(await page.locator('#clip-playback-status').textContent(), /Clip finished/);
    await checkPlayback(() => page.locator('#moment-2 .clip-play').click(), '#watch-container', '2144', '2269');
    await page.clock.fastForward(400);
    assert.equal(await page.locator('#moment-2 > #watch-panel').count(), 1);
    await page.evaluate(() => window.playerFixtures.at(-1).events.onAutoplayBlocked());
    assert.match(await page.locator('#clip-playback-status').textContent(), /Press play/);
    await page.evaluate(() => window.playerFixtures.at(-1).events.onError());
    assert.match(await page.locator('#clip-playback-status').textContent(), /Use Full video/);
    await page.clock.resume();
    await page.evaluate(first => renderAnswer({status: 'insufficient_evidence', message: 'No relevant conversation found.',
      points: [{text: 'Stale answer', citations: [first]}], recommendations: [{citation: first}]}), first);
    assert.equal(await page.locator('.moment, .citation-link, iframe').count(), 0);
    assert.equal(await page.evaluate(() => window.playerFixtures.at(-1).destroyed), true);
    assert.deepEqual(errors, []);
    console.log('Player checks passed: clip bounds, switching, replay, direct answer references, saved moments, full-video links, and origin-only Referer.');
  } finally {await browser.close();}
})().catch(error => {console.error(error); process.exitCode = 1;});

// Auth navigation and stale-tab privacy checks; all identities and APIs are fixtures.
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const {execFileSync} = require('node:child_process');

(async () => {
  const assets = path.join(__dirname, '../knowledge/web');
  const output = process.argv[2] || '/tmp/reader-auth-check';
  await fs.mkdir(output, {recursive: true});
  const html = (await fs.readFile(path.join(assets, 'index.html'), 'utf8')).replace('data-accounts="local"', 'data-accounts="required"');
  const pages = JSON.parse(execFileSync(path.join(__dirname, '../.venv/bin/python'), ['-c',
    "import json; from knowledge.public_server import sign_in_page; print(json.dumps({'signin': sign_in_page(), 'signup': sign_in_page(signup=True), 'cancelled': sign_in_page(error='cancelled'), 'signedout': sign_in_page(signed_out=True)}))"], {cwd: path.join(__dirname, '..'), encoding: 'utf8'}));
  let owner = null, expired = false;
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const redirect = location => { response.writeHead(303, {location}); response.end(); };
    let body;
    if (['/sign-in', '/sign-up'].includes(url.pathname)) {
      if (owner) return redirect(url.searchParams.get('next') || '/');
      body = url.pathname === '/sign-up' ? pages.signup : url.searchParams.get('error') === 'cancelled' ? pages.cancelled : pages.signin;
    } else if (url.pathname === '/') {
      if (!owner) return redirect('/sign-in');
      body = html;
    } else if (url.pathname === '/signed-out') {
      body = pages.signedout;
    } else { response.writeHead(404); response.end(); return; }
    response.writeHead(200, {'content-type': 'text/html', 'cache-control': 'no-store'});
    response.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch(process.env.CHROME_PATH
    ? {headless: true, executablePath: process.env.CHROME_PATH}
    : {headless: true, channel: 'chrome'});
  try {
    const context = await browser.newContext({viewport: {width: 1440, height: 900}, reducedMotion: 'reduce'});
    context.setDefaultTimeout(10000);
    const errors = [], logoutOwners = [];
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    const types = {'.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.png': 'image/png'};
    const allowed = new Set(['reader.js', 'reader.css', 'theme.js', 'orb.js', 'thinking-orbs.js', 'sign-in.js', 'catalog.json', 'geist-latin.woff2', 'google-sans.ttf', 'media/raj-shamani.jpg', 'media/google-g.png', 'favicon.svg']);
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (['/', '/sign-in', '/sign-up', '/signed-out'].includes(url.pathname)) return route.continue();
      if (url.pathname.startsWith('/api/') || url.pathname === '/auth/logout') {
        if (!owner || expired) return route.fulfill({status: 401, json: {error: 'Sign in to use your account.'}});
        if (url.pathname === '/api/account') return route.fulfill({json: {id: owner, csrf: owner + '-csrf', email: owner + '@example.test'}});
        if (route.request().headers()['x-account-id'] !== owner) return route.fulfill({status: 409, json: {error: 'Account changed', code: 'session_changed'}});
        if (url.pathname === '/auth/logout') {
          assert.equal(route.request().headers()['x-csrf-token'], owner + '-csrf');
          logoutOwners.push(owner); owner = null;
          return route.fulfill({json: {redirect: origin + '/signed-out'}});
        }
        if (url.pathname === '/api/status') return route.fulfill({json: {sources: [{id: 'Y566_T-YlNQ', state: 'ready'}], credentials: {answers: true}}});
        if (url.pathname === '/api/collections') return route.fulfill({json: {revision: 1, items: [{id: owner, name: owner + ' private collection', items: []}]}});
        if (url.pathname === '/api/responses') return route.fulfill({json: {items: [], total: 0}});
        return route.fulfill({status: 404, json: {error: 'Saved response not found.'}});
      }
      const file = url.pathname.slice(1);
      assert.ok(allowed.has(file), 'Unexpected request: ' + file);
      return route.fulfill({body: await fs.readFile(path.join(assets, file)), contentType: types[path.extname(file)]});
    });
    const page = await context.newPage();
    const destination = '/#answer/' + 'a'.repeat(32);
    await page.goto(origin + destination);
    assert.equal(new URL(page.url()).pathname, '/sign-in');
    assert.equal(new URL(await page.locator('#sign-in-link').getAttribute('href'), origin).searchParams.get('next'), destination);
    for (const target of ['/#saved/history', '//attacker.test', 'https://attacker.test', '/#saved\n']) {
      await page.goto(origin + '/sign-in?next=' + encodeURIComponent(target));
      assert.equal(new URL(await page.locator('#sign-in-link').getAttribute('href'), origin).searchParams.get('next'), target === '/#saved/history' ? target : '/');
    }
    await page.goto(origin + '/sign-in?next=' + encodeURIComponent(destination));
    await page.locator('#auth-switch-link').click();
    await page.getByRole('heading', {name: 'Create an account.'}).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('next'), destination);
    assert.equal(new URL(await page.locator('#sign-in-link').getAttribute('href'), origin).searchParams.get('next'), destination);
    await page.locator('#auth-switch-link').click();
    await page.getByRole('heading', {name: 'Sign in.'}).waitFor();
    await page.goto(origin + '/sign-in?error=cancelled&next=' + encodeURIComponent(destination));
    assert.match(await page.locator('[role=alert]').innerText(), /cancelled/);
    assert.equal(await page.locator('#sign-in-link').getAttribute('aria-disabled'), null);
    await page.goto(origin + '/sign-in?next=' + encodeURIComponent(destination));
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      for (const width of [1440, 768, 390, 320]) {
        await page.setViewportSize({width, height: 900});
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        assert.equal(await page.locator('#question, #response-history, #collection-tabs').count(), 0, 'Public sign-in page contains no private application views');
        assert.equal(await page.locator('header').count(), 1);
        assert.ok(await page.locator('#sign-in-link').evaluate(node => node.getBoundingClientRect().height >= 44));
        if ([1440, 390].includes(width)) await page.screenshot({path: path.join(output, `signin-${theme}-${width}.png`), fullPage: true});
      }
    }
    console.log('Sign-in routes and responsive layouts passed.');
    const privateView = async tab => {
      await tab.waitForFunction(() => Boolean(account));
      await tab.evaluate(() => {
        beginAnswer('Alice private question');
        renderAnswer({status: 'answered', points: [{text: 'Alice private answer.', citations: []}]});
      });
    };

    owner = 'alice';
    await page.goto(origin);
    await privateView(page);
    const peer = await context.newPage();
    await peer.goto(origin); await privateView(peer);
    // Signing into Bob in another tab must leave Alice's private view.
    const switching = peer.waitForRequest(request => new URL(request.url()).pathname === '/sign-in');
    owner = 'bob'; await page.reload(); await switching;
    await peer.waitForFunction(() => typeof account !== 'undefined' && account?.id === 'bob');
    assert.doesNotMatch(await peer.locator('body').innerText(), /Alice private/);
    await peer.close();
    console.log('Account-switch privacy passed.');

    // A stale account header is distinct from an ordinary collection revision conflict.
    await page.waitForFunction(() => account?.id === 'bob');
    owner = 'alice';
    const mismatch = page.waitForRequest(request => new URL(request.url()).pathname === '/sign-in');
    await page.evaluate(() => api('/api/collections').catch(() => {}));
    await mismatch;
    await page.waitForFunction(() => typeof account !== 'undefined' && account?.id === 'alice');
    console.log('Stale account rejection passed.');

    // Session expiry while viewing an answer hides it and offers sign-in with the same route.
    await privateView(page);
    await page.evaluate(() => history.replaceState(null, '', '#answer/' + 'b'.repeat(32)));
    expired = true; owner = null;
    const expiration = page.waitForRequest(request => new URL(request.url()).pathname === '/sign-in');
    await page.evaluate(() => api('/api/responses?offset=0').catch(() => {}));
    await expiration;
    await page.locator('#sign-in-link').waitFor();
    assert.equal(new URL(await page.locator('#sign-in-link').getAttribute('href'), origin).searchParams.get('next'), '/#answer/' + 'b'.repeat(32));
    assert.doesNotMatch(await page.locator('body').innerText(), /Alice private/);
    console.log('Expired-session privacy passed.');

    // Sign-out must work during generation and also clear an existing second tab.
    expired = false; owner = 'alice'; await page.goto(origin);
    await page.waitForFunction(() => canAnswer());
    const second = await context.newPage(); await second.goto(origin); await privateView(second);
    await page.evaluate(() => {
      const fetchNormally = window.fetch;
      window.fetch = (url, options) => url === '/api/ask/stream'
        ? new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))))
        : fetchNormally(url, options);
    });
    await page.locator('#question').fill('A private question still generating');
    await page.locator('#question').press('Enter');
    await page.locator('#answer-progress').waitFor();
    await page.locator('#account-button').click();
    await page.waitForURL('**/signed-out');
    await second.locator('#sign-in-link').waitFor();
    assert.equal(await page.locator('#answer, #response-history').count(), 0);
    assert.doesNotMatch(await second.locator('body').innerText(), /Alice private/);
    assert.deepEqual(logoutOwners, ['alice']);
    assert.deepEqual(errors, []);
    console.log('Auth browser checks passed: safe return routes, sign-in layouts, account switches, expired sessions, private-view clearing, and sign-out across tabs during generation.');
  } catch (error) { console.error(error); throw error; }
  finally { server.closeAllConnections(); server.close(); await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

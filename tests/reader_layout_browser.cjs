const assert = require('node:assert/strict');
const path = require('node:path');

module.exports = async (page, output, citation) => {
  await page.emulateMedia({reducedMotion: 'reduce'});
  const answer = {status: 'answered', answer_parts: [
    {text: 'Build a routine you can repeat consistently.', citations: [citation]},
    {text: 'Give yourself time to recover between focused sessions.', citations: [citation]},
  ], answer_limitation: 'These excerpts do not establish a personal outcome.',
  recommendations: [{clip_title: 'Building a consistent routine', summary: 'The speaker discusses routines and sustained focus.',
    limitation: 'This is general context rather than a personalized schedule.', citation}]};
  await page.evaluate(() => { document.querySelector('#toast').hidden = true; });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    for (const width of [1440, 768, 390, 320]) {
      await page.setViewportSize({width, height: 900});
      for (const view of ['discover', 'progress', 'answer', 'saved']) {
        await page.evaluate(({view, answer}) => {
          document.querySelector('#answer-progress').hidden = true;
          if (view === 'progress') {
            beginAnswer('How can I improve my focus?'); generationPhase('review');
            setProgress('Checking source clips against the original transcripts…', false, true);
            document.querySelector('#answer-progress').hidden = false;
            document.querySelector('#answer-composer').hidden = true;
            document.querySelector('#answer-elapsed').textContent = 'Elapsed 0:08';
          } else if (view === 'answer') { beginAnswer('How can I improve my focus?'); renderAnswer(answer); }
          else navigate(view, {libraryTab: 'collections'});
          document.activeElement?.blur();
          window.scrollTo({top: 0, behavior: 'instant'});
        }, {view, answer});
        const issues = await page.evaluate(() => {
          const problems = [];
          if (document.documentElement.scrollWidth > innerWidth) problems.push('Horizontal overflow');
          const rgb = text => (text.match(/[\d.]+/g) || []).map(Number);
          const luminance = values => values.slice(0, 3).map(v => v / 255)
            .map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
            .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
          const background = node => {
            for (let current = node; current; current = current.parentElement) {
              const values = rgb(getComputedStyle(current).backgroundColor);
              if (values.length === 3 || values[3] === 1) return values;
            }
            return [255, 255, 255];
          };
          const selectors = '.main-nav button, .back-link, .availability-note, .episode-meta, .episode-guest, .moment-copy, .moment-limit, .clip-source, .clip-time, .clip-play, .answer-lead, .answer-limitation, .library-tabs button, .folder-copy strong, .folder-copy>span, .action-menu summary, .action-menu button, .remove-save, .phase-marker, .phase-label, .phase-state, #answer-step, .request-status, .answer-scope, #answer-elapsed';
          for (const node of document.querySelectorAll(selectors)) {
            if (!node.getClientRects().length) continue;
            const style = getComputedStyle(node), fg = luminance(rgb(style.color)), bg = luminance(background(node));
            const contrast = (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05);
            if (contrast < 4.5) problems.push(`${node.className || node.id || node.textContent.trim()}: text contrast ${contrast.toFixed(2)}`);
          }
          for (const node of document.querySelectorAll('.icon-button, .search-submit, .theme-toggle, .clip-play, .library-tabs button, .collection-folder, .action-menu summary, .topic-button')) {
            if (!node.getClientRects().length) continue;
            const bounds = node.getBoundingClientRect();
            if (bounds.width < 44 || bounds.height < 44) problems.push(`${node.className || node.id}: touch control ${bounds.width}×${bounds.height}`);
          }
          return problems;
        });
        assert.deepEqual(issues, [], `${theme} ${width}px ${view}`);
        if (view === 'answer') {
          // The answer reads as one chat column at every width; the composer stays pinned below it.
          const [question, summary, clips] = await Promise.all(['#asked-question', '#answer-summary', '#moments-section'].map(selector => page.locator(selector).boundingBox()));
          assert.ok(question.y + question.height <= summary.y, 'The question precedes the reply');
          assert.ok(summary.y + summary.height <= clips.y, 'The answer precedes its source clips');
          assert.ok(Math.abs(summary.x - clips.x) < 1 && summary.width === clips.width, 'Answer and sources share one column');
          assert.equal(await page.locator('#answer-composer').evaluate(node => getComputedStyle(node).position), 'sticky');
        }
        if ([1440, 390].includes(width)) {
          await page.evaluate(async () => {
            await document.fonts.ready;
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          });
          await page.screenshot({path: path.join(output, `ux-${theme}-${view}-${width}.png`), fullPage: true});
        }
      }
    }
  }
  console.log('Layout checks passed: 320/390/768/1440px, both themes, readable core text, touch controls, and overflow.');
};

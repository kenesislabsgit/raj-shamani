// <thinking-orb state="searching" size="64">: the thinking-orbs canvas without React.
// Mirrors the package's own component: two tuned sizes, monochrome ink that follows
// the page theme, a static frame for reduced motion, and no drawing while offscreen
// or in a hidden tab. Every orb shares one clock and one animation frame loop.
import {MODE_DRAWS, resolvePreset} from './thinking-orbs.js';

const LABELS = {
  working: 'Working…', searching: 'Searching…', solving: 'Solving…', listening: 'Listening…',
  connecting: 'Connecting…', weaving: 'Weaving…', composing: 'Composing…', breathing: 'Thinking…', shaping: 'Shaping…',
};
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const darkScheme = matchMedia('(prefers-color-scheme: dark)');
const orbs = new Set();
const running = new Set();
let frame = 0;

function ancestorTheme(node) {
  for (let el = node; el; el = el.parentElement) {
    const theme = el.getAttribute('data-theme');
    if (theme === 'dark' || el.classList.contains('dark')) return true;
    if (theme === 'light' || el.classList.contains('light')) return false;
  }
  return null;
}
function tick() {
  const seconds = performance.now() / 1000;
  running.forEach(orb => orb.draw(seconds * orb.speed));
  frame = running.size ? requestAnimationFrame(tick) : 0;
}
function refreshAll() { orbs.forEach(orb => orb.render()); }
// Class changes are frequent; repaint only the orbs whose resolved theme changed.
function refreshThemes() { orbs.forEach(orb => { if (orb.resolveDark() !== orb.dark) orb.render(); }); }

const visibility = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
  entries.forEach(entry => { entry.target.onscreen = entry.isIntersecting; entry.target.schedule(); });
}) : null;
new MutationObserver(refreshThemes).observe(document.documentElement, {attributes: true, attributeFilter: ['class', 'data-theme'], subtree: true});
darkScheme.addEventListener('change', refreshThemes);
reducedMotion.addEventListener('change', refreshAll);
document.addEventListener('visibilitychange', () => orbs.forEach(orb => orb.schedule()));

class ThinkingOrb extends HTMLElement {
  static observedAttributes = ['state', 'size', 'theme', 'speed', 'paused'];

  connectedCallback() {
    if (!this.canvas) {
      this.canvas = document.createElement('canvas');
      this.canvas.setAttribute('aria-hidden', 'true');
      this.append(this.canvas);
    }
    this.onscreen = !visibility;
    orbs.add(this); visibility?.observe(this);
    this.render();
  }

  disconnectedCallback() {
    orbs.delete(this); running.delete(this); visibility?.unobserve(this);
  }

  // Upgrading parsed markup reports attributes before connectedCallback adds the canvas.
  attributeChangedCallback() { if (this.isConnected && this.canvas) this.render(); }

  resolveDark() {
    const theme = this.getAttribute('theme');
    return theme === 'dark' || (theme !== 'light' && (ancestorTheme(this) ?? darkScheme.matches));
  }

  render() {
    const state = LABELS[this.getAttribute('state')] ? this.getAttribute('state') : 'working';
    const size = this.getAttribute('size') === '20' ? 20 : 64;
    this.speed = Number(this.getAttribute('speed')) > 0 ? Number(this.getAttribute('speed')) : 1;
    this.dark = this.resolveDark();
    if (this.getAttribute('aria-hidden') !== 'true') {
      this.setAttribute('role', 'img');
      // A label supplied by the page wins; the default follows the current state.
      if (!this.hasAttribute('aria-label') || this.defaultLabel) {
        this.defaultLabel = true; this.setAttribute('aria-label', LABELS[state]);
      }
    }
    const ratio = Math.min(2, devicePixelRatio || 1);
    this.size = size; this.ratio = ratio;
    if (this.canvas.width !== Math.round(size * ratio)) {
      this.canvas.width = this.canvas.height = Math.round(size * ratio);
    }
    const {mode, speed, opts} = resolvePreset(state, size);
    this.paint = MODE_DRAWS[mode]; this.opts = opts; this.speed *= speed;
    this.context = this.canvas.getContext('2d');
    // Reduced motion keeps one representative frame, as in the original component.
    this.draw(reducedMotion.matches ? 0.6 : performance.now() / 1000 * this.speed);
    this.schedule();
  }

  draw(time) {
    if (!this.context) return;
    this.context.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    this.context.clearRect(0, 0, this.size, this.size);
    this.paint(this.context, this.size, time, this.dark, this.opts);
  }

  schedule() {
    const animate = this.isConnected && this.context && this.onscreen && !document.hidden &&
      !reducedMotion.matches && !this.hasAttribute('paused');
    if (animate) running.add(this); else running.delete(this);
    if (running.size && !frame) frame = requestAnimationFrame(tick);
  }
}

if (!customElements.get('thinking-orb')) customElements.define('thinking-orb', ThinkingOrb);

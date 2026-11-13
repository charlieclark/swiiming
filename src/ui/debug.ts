import type * as THREE from 'three';

/**
 * On-screen start-up timings, shown when the page is opened with `?debug`. Useful on a
 * phone, where there is no console to read.
 */
export function showStartupTimings(renderer: THREE.WebGLRenderer) {
  if (!new URLSearchParams(location.search).has('debug')) return;
  const box = document.createElement('pre');
  box.style.cssText =
    'position:fixed;left:8px;top:8px;z-index:99;margin:0;padding:8px 10px;max-width:92vw;' +
    'font:11px/1.45 ui-monospace,Menlo,monospace;white-space:pre-wrap;color:#fff;' +
    'background:rgba(23,35,44,0.86);border-radius:6px;pointer-events:none';
  document.body.appendChild(box);

  const gl = renderer.getContext();
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'unknown';
  const parallel = gl.getExtension('KHR_parallel_shader_compile') ? 'yes' : 'no';

  let frames = 0;
  let since = performance.now();
  let fps = 0;
  const tick = (now: number) => {
    frames++;
    if (now - since >= 1000) {
      fps = (frames * 1000) / (now - since);
      frames = 0;
      since = now;
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      const lines = [`page fetched   ${nav ? Math.round(nav.responseEnd) : '?'} ms`];
      let prev = 0;
      for (const mark of performance.getEntriesByType('mark')) {
        if (!mark.name.startsWith('pool:')) continue;
        const at = Math.round(mark.startTime);
        lines.push(`${mark.name.slice(5).padEnd(14)} ${String(at).padStart(5)} ms  (+${at - prev})`);
        prev = at;
      }
      lines.push(`fps ${fps.toFixed(0)}  programs ${renderer.info.programs?.length ?? '?'}  parallel compile ${parallel}`);
      lines.push(`pixels ${gl.drawingBufferWidth} x ${gl.drawingBufferHeight}`);
      lines.push(gpu);
      box.textContent = lines.join('\n');
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

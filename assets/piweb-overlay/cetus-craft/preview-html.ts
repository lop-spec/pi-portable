// Cetus's Escape/link bridge; keep HTML in an opaque sandbox (no same-origin).
const bridge = `<script>document.addEventListener('keydown',function(e){if(e.key==='Escape')parent.postMessage({__piPreview:'escape'},'*')});document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a[href]');if(!a||a.getAttribute('href').startsWith('#'))return;e.preventDefault();parent.postMessage({__piPreview:'link',url:a.href},'*')});</script>`;
export function previewHtml(html: string): string {
  return /<head[^>]*>/i.test(html) ? html.replace(/(<head[^>]*>)/i, `$1${bridge}`) : bridge + html;
}

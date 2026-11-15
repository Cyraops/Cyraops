/**
 * Pages are HTML authored by the assistant, so the content is untrusted by the
 * time it reaches a browser. The real boundary is the sandboxed iframe the page
 * renders inside (no allow-same-origin, no allow-scripts); this sanitiser is the
 * second layer, removing the active content that has no business in a document.
 */

import { PAGE_KIT_CSS, renderKit } from "./kit";

const MAX_CONTENT = 400_000;

/**
 * Models frequently wrap HTML in a markdown fence even when asked for raw
 * markup. Unwrapping it here means a fence never shows up as literal text in
 * the rendered page.
 */
export function unwrapHtmlFence(input: string): string {
  const text = String(input ?? "").trim();
  const fenced = /^```(?:html|HTML)?\s*\n([\s\S]*?)\n?```$/.exec(text);
  const body = fenced ? fenced[1] : text;
  return body.trim();
}

export function sanitizePageHtml(input: string): string {
  let html = unwrapHtmlFence(input).slice(0, MAX_CONTENT);

  // Drop script/style-less active containers wholesale.
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "");
  html = html.replace(/<script\b[^>]*\/?>/gi, "");
  html = html.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/gi, "");
  html = html.replace(/<object\b[^>]*>[\s\S]*?<\/object\s*>/gi, "");
  html = html.replace(/<embed\b[^>]*\/?>/gi, "");
  html = html.replace(/<form\b[^>]*>[\s\S]*?<\/form\s*>/gi, "");
  html = html.replace(/<(link|meta)\b[^>]*>/gi, "");

  // Inline event handlers (onclick=, onerror=, ...).
  html = html.replace(/\s+on[a-z]+\s*=\s*"[^"]*"/gi, "");
  html = html.replace(/\s+on[a-z]+\s*=\s*'[^']*'/gi, "");
  html = html.replace(/\s+on[a-z]+\s*=\s*[^\s>]+/gi, "");

  // Any javascript:/data: URL that could execute on click.
  html = html.replace(/(href|src|xlink:href)\s*=\s*(["'])\s*(javascript|vbscript|data:text\/html)[^"']*\2/gi, '$1="#"');

  // formaction is only meaningful inside forms, which are already stripped.
  html = html.replace(/\s+formaction\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");

  // Declarative kit tags become styled HTML and inline SVG here, so a page
  // looks designed without ever shipping a script to the viewer.
  return renderKit(html);
}

/** Wrap page HTML in a standalone document for the public share route. */
export function renderStandalonePage(title: string, content: string): string {
  const safeTitle = title.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] as string);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${safeTitle}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px 20px 64px;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #16151f; background: #f6f6fb; line-height: 1.6;
  }
  main { max-width: 900px; margin: 0 auto; background: #fff; border: 1px solid #e6e5f0;
    border-radius: 16px; padding: 28px 32px; box-shadow: 0 1px 2px rgba(16,15,40,.04); }
  ${PAGE_KIT_CSS}
  h1 { font-size: 24px; margin: 0 0 4px; }
  h2 { font-size: 18px; margin: 24px 0 8px; }
  h3 { font-size: 15px; margin: 20px 0 6px; }
  table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 13px; }
  th, td { border-bottom: 1px solid #eceaf4; padding: 8px 10px; text-align: left; }
  th { background: #f6f6fb; font-weight: 600; }
  code { background: #f2f1f8; padding: 1px 5px; border-radius: 5px; font-size: 12px; }
  pre { background: #f6f6fb; padding: 12px 14px; border-radius: 10px; overflow-x: auto; }
  .cyraops-footer { max-width: 900px; margin: 14px auto 0; font-size: 11px; color: #6b6880; text-align: center; }
  .cyraops-footer a { color: #5b4bd6; text-decoration: none; }
</style>
</head>
<body>
<main>${content}</main>
<div class="cyraops-footer">Shared from Cyraops · <a href="https://www.cyraops.com" rel="noopener">cyraops.com</a></div>
</body>
</html>`;
}

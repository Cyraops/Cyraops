import { useCallback, useEffect, useState } from "react";

/**
 * A hash router, deliberately tiny.
 *
 * Real navigation — separate URLs per offering, back button, shareable links —
 * rather than one long scroll pretending to be a site. Hash routing avoids a
 * server rewrite rule, so this build can be dropped onto any static host.
 *
 *   #/                         home
 *   #/solutions                axis index
 *   #/solutions/llm-studio     offering detail
 */

export function useRoute() {
  const [path, setPath] = useState(() => currentPath());

  useEffect(() => {
    const onChange = () => setPath(currentPath());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  return path;
}

function currentPath(): string {
  const raw = window.location.hash.replace(/^#/, "");
  return raw === "" ? "/" : raw;
}

export function navigate(href: string) {
  const target = href.startsWith("#") ? href.slice(1) : href;
  if (window.location.hash === `#${target}`) return;
  window.location.hash = target;
  // Detail pages start at the top; in-page anchors are handled by the caller.
  window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
}

/** "/solutions/assistant-workspace" -> ["solutions", "assistant-workspace"] */
export function segments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

export function useScrollTopOnRouteChange(path: string) {
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  }, [path]);
}

export function useLinkHandler() {
  return useCallback((event: React.MouseEvent<HTMLAnchorElement>, href: string) => {
    if (!href.startsWith("#")) return;
    // Pure in-page anchors (already on the home page) keep smooth scrolling.
    if (href.startsWith("#s") || href.startsWith("#contact") || href === "#top") return;
    event.preventDefault();
    navigate(href);
  }, []);
}

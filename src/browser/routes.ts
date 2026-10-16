export function mapBrowserPathToInitialRoute(pathname: string, search: string) {
  if (pathname === "/share/receive" && search) {
    const params = new URLSearchParams(search);

    const prompt = ["title", "text", "url"]
      .flatMap((name) => {
        const value = params.get(name);
        return value === null ? [] : [`${name}: ${value}`];
      })
      .join("\n");

    return {
      memoryPath: prompt
        ? `/?${new URLSearchParams({ prompt }).toString()}`
        : "/",
      browserPath: "/",
    };
  }

  return {
    memoryPath: mapBrowserPathToRoute(pathname),
  };
}

function mapBrowserPathToRoute(pathname: string): string {
  // /app/<server>/<tool> deep-links a plugin sidebar page, e.g. a home-screen
  // bookmark for Mission Control.
  const app = pathname.match(/^\/app\/([^?#]+)$/);
  if (app) {
    return `/mcp-app/${app[1]}`;
  }

  const match = pathname.match(/^\/thread\/([^/]+)$/);
  if (match) {
    try {
      return `/local/${decodeURIComponent(match[1])}`;
    } catch {
      return "/";
    }
  }

  return "/";
}

export function mapMemoryPathToBrowserPath(pathname: string) {
  if (pathname === "/") {
    return { path: "/", titleChange: "Codex" };
  }

  // Plugin sidebar pages (MCP App global entrypoints): /mcp-app/<server>/<tool>
  // and /mcp-app/plugins/<pluginId>/<tool>.
  const app = pathname.match(/^\/mcp-app\/([^?#]+)$/);
  if (app) {
    return { path: `/app/${app[1]}` };
  }

  const match = pathname.match(/^\/local\/([^/?#]+)$/);
  if (!match) {
    return null;
  }

  return { path: `/thread/${encodeURIComponent(match[1])}` };
}

export function dispatchNavigateToRoute(path: string): void {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "navigate-to-route",
        path,
      },
    }),
  );
}

window.addEventListener("popstate", () => {
  dispatchNavigateToRoute(mapBrowserPathToRoute(window.location.pathname));
});

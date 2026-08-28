import type { Plugin } from "vite";

const leftAngle = String.fromCharCode(60);
const rightAngle = String.fromCharCode(62);

function openTag(name: string, attributes = "") {
  return `${leftAngle}${name}${attributes ? ` ${attributes}` : ""}${rightAngle}`;
}

function closeTag(name: string) {
  return `${leftAngle}/${name}${rightAngle}`;
}

function createIndexHtml() {
  return [
    openTag("!DOCTYPE", "html"),
    openTag("html", 'lang="en" style="height: 100%"'),
    "  " + openTag("head"),
    '    ' + openTag("meta", 'charset="UTF-8" /'),
    '    ' + openTag("meta", 'name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1" /'),
    '    ' + openTag("meta", 'property="og:title" content="Mockup Canvas" /'),
    '    ' + openTag("meta", 'property="og:description" content="UI prototyping sandbox with infinite canvas" /'),
    '    ' + openTag("meta", 'property="og:type" content="website" /'),
    '    ' + openTag("meta", 'name="twitter:card" content="summary_large_image" /'),
    '    ' + openTag("meta", 'name="twitter:title" content="Mockup Canvas" /'),
    '    ' + openTag("meta", 'name="twitter:description" content="UI prototyping sandbox with infinite canvas" /'),
    `    ${openTag("title")}Mockup Canvas${closeTag("title")}`,
    '    ' + openTag("link", `rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E🎨%3C/text%3E%3C/svg%3E"`),
    "  " + closeTag("head"),
    '  ' + openTag("body", 'style="height: 100%; margin: 0"'),
    '    ' + openTag("div", 'id="root" style="height: 100%"') + closeTag("div"),
    '    ' + openTag("script", 'type="module" src="/src/font-loader.ts"') + closeTag("script"),
    '    ' + openTag("script", 'type="module" src="/src/main.tsx"') + closeTag("script"),
    "  " + closeTag("body"),
    closeTag("html"),
  ].join("\n");
}

export function mockupIndexHtmlPlugin(): Plugin {
  return {
    name: "mockup-index-html",
    transformIndexHtml: {
      order: "pre",
      handler: createIndexHtml,
    },
  };
}
const fontGroups = [
  [
    "Architects+Daughter",
    "DM+Sans:ital,opsz,wght@0,9..40,100..1000;1,9..40,100..1000",
    "Fira+Code:wght@300..700",
    "Geist+Mono:wght@100..900",
    "Geist:wght@100..900",
  ],
  [
    "IBM+Plex+Mono:ital,wght@0,100..700;1,100..700",
    "IBM+Plex+Sans:ital,wght@0,100..700;1,100..700",
    "Inter:ital,opsz,wght@0,14..32,100..900;1,14..32,100..900",
    "JetBrains+Mono:ital,wght@0,100..800;1,100..800",
    "Libre+Baskerville:ital,wght@0,400;0,700;1,400",
  ],
  [
    "Lora:ital,wght@0,400..700;1,400..700",
    "Merriweather:ital,opsz,wght@0,18..144,300..900;1,18..144,300..900",
    "Montserrat:ital,wght@0,100..900;1,100..900",
    "Open+Sans:ital,wght@0,300..800;1,300..800",
    "Outfit:wght@100..900",
  ],
  [
    "Oxanium:wght@200..800",
    "Playfair+Display:ital,wght@0,400..900;1,400..900",
    "Plus+Jakarta+Sans:ital,wght@0,200..800;1,200..800",
    "Poppins:ital,wght@0,100..900;1,100..900",
    "Roboto+Mono:ital,wght@0,100..700;1,100..700",
  ],
  [
    "Roboto:ital,wght@0,100..900;1,100..900",
    "Source+Code+Pro:ital,wght@0,200..900;1,200..900",
    "Source+Serif+4:ital,opsz,wght@0,8..60,200..900;1,8..60,200..900",
    "Space+Grotesk:wght@300..700",
    "Space+Mono:ital,wght@0,400;0,700;1,400;1,700",
  ],
];

for (const fonts of fontGroups) {
  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.media = "print";
  stylesheet.href = `https://fonts.googleapis.com/css2?${fonts
    .map((font) => `family=${font}`)
    .join("&")}&display=swap`;
  stylesheet.onload = () => {
    stylesheet.media = "all";
  };
  document.head.append(stylesheet);
}
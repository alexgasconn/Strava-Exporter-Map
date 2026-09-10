100 cims
=========

Descripció
-

100 cims és una interfície per visualitzar i portar el control del Repte 100 Cims. Importa les teves exportacions de Strava o arxius GPS (.gpx, .fit) i marca els cims completats.

Què he fet (millores SEO i canvi de nom)

- He canviat el nom de l'app a "100 cims" a `index.html`, `metadata.json`, `package.json` i la UI (`src/components/Sidebar.tsx`).
- He afegit meta tags importants: `title`, `description`, `keywords`, `canonical`, `og:*` i `twitter:card`.
- He afegit JSON-LD (`schema.org`) per `WebSite` i `Organization` a `index.html`.
- He afegit `public/robots.txt` i `public/sitemap.xml` per millorar el rastreig per cercadors.
- He afegit una imatge OG bàsica `public/assets/og.svg` i un `site.webmanifest`.

Com executar

- Instal·lar dependències:

```powershell
npm install
```

- Executar en mode desenvolupament:

```powershell
npm run dev
```

- Compilar per producció:

```powershell
npm run build
```

Recomanacions SEO addicionals

- Registrar un domini i establir `link rel="canonical"` a la URL completa del lloc.
- Generar una imatge OG dedicada (1200×630) en PNG o JPG amb alta qualitat per a una millor aparença a les xarxes socials.
- Afegir meta tags per idioma si vols suportar múltiples idiomes (`hreflang`).
- Afegir un sitemap dinàmic si el lloc creix amb moltes rutes.
- Configurar headers del servidor per a caché i compressió (gzip/brotli).

Desplegament suggerit

- Vercel o Netlify: desplegament estàtic senzill per a aplicacions Vite.

Si vols, puc:

- Generar una imatge OG en format PNG (si em dones un text o paleta).
- Afegir suport multilengua i etiquetes `hreflang`.
- Configurar meta tags addicionals per activitat/cim quan es comparteixi una vista específica.

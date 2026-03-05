# Aionis Landing (Next.js)

## Run locally

```bash
cd web
npm install
npm run dev
```

Open http://localhost:3000

## Production build

```bash
cd web
npm run build
```

Static files are generated into `web/out`.

## Deploy to GitHub Pages

This repo includes a workflow at `.github/workflows/deploy-pages.yml`.

- Push changes in `web/` to `main`.
- GitHub Actions builds and deploys `web/out` to Pages.
- The site URL is expected to be:
  `https://cognary.github.io/aionis-openclaw-plugin/`

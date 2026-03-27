# Live Site Proof

This repo includes a live-site acceptance harness at `scripts/validate-live-sitegeist-journeys.mjs`.

It launches the unpacked extension from `dist-chrome`, configures OpenRouter, and drives Sitegeist through real browser journeys with cookie acceptance required before each major step.

## Commands

```bash
node ./scripts/build.mjs
SITEGEIST_TARGETS=rangerover node ./scripts/validate-live-sitegeist-journeys.mjs
SITEGEIST_TARGETS=johnlewis node ./scripts/validate-live-sitegeist-journeys.mjs
```

## Latest Passing Artifacts

### Range Rover

- Report: `output/playwright/live-sitegeist-journeys-2026-03-27T22-24-13.813Z/report.json`
- Screenshots:
  - `output/playwright/live-sitegeist-journeys-2026-03-27T22-24-13.813Z/range-rover-homepage-start.png`
  - `output/playwright/live-sitegeist-journeys-2026-03-27T22-24-13.813Z/range-rover-step1-sport-page.png`
  - `output/playwright/live-sitegeist-journeys-2026-03-27T22-24-13.813Z/range-rover-step2-options-and-accessories.png`
  - `output/playwright/live-sitegeist-journeys-2026-03-27T22-24-13.813Z/range-rover-step3-models-and-specifications.png`

Validated journey:

1. Accept cookies on the Range Rover homepage and open Range Rover Sport.
2. Accept cookies again if needed and navigate to the exact GB Options and Accessories page.
3. Accept cookies again if needed and navigate to the exact GB Models and Specifications page.

### John Lewis

- Report: `output/playwright/live-sitegeist-journeys-2026-03-27T22-15-06.013Z/report.json`
- Screenshots:
  - `output/playwright/live-sitegeist-journeys-2026-03-27T22-15-06.013Z/john-lewis-search-results-start.png`
  - `output/playwright/live-sitegeist-journeys-2026-03-27T22-15-06.013Z/john-lewis-step1-search-results.png`
  - `output/playwright/live-sitegeist-journeys-2026-03-27T22-15-06.013Z/john-lewis-step2-product-page.png`
  - `output/playwright/live-sitegeist-journeys-2026-03-27T22-15-06.013Z/john-lewis-step3-added-to-basket.png`
  - `output/playwright/live-sitegeist-journeys-2026-03-27T22-15-06.013Z/john-lewis-step4-basket.png`

Validated journey:

1. Accept cookies on John Lewis candle search results and stay on the visible results grid.
2. Accept cookies again if needed, avoid survey overlays, and navigate to the exact first product URL.
3. Accept cookies again if needed and add the visible product to basket.
4. Open the basket and verify the expected product is present.

## Notes

- The harness now tells Sitegeist to always accept cookie or consent banners unless the user explicitly asks otherwise.
- For unstable live sites, exact target URLs are more reliable than asking the agent to discover the next page purely from navigation affordances.
- Running one target at a time is the most reliable way to produce clean acceptance artifacts for live websites.
